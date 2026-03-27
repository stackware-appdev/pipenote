import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import cors from 'cors';
import pg from 'pg';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function checkUsageLimit(userId) {
  const result = await pool.query(
    'SELECT reports_this_month FROM users WHERE user_id = $1',
    [userId]
  );
  
  if (!result.rows.length) {
    await pool.query(
      'INSERT INTO users (user_id, reports_this_month) VALUES ($1, 0)',
      [userId]
    );
    return { allowed: true, remaining: 10 };
  }
  
  const count = result.rows[0].reports_this_month;
  if (count >= 10) {
    return { allowed: false, remaining: 0 };
  }
  
  return { allowed: true, remaining: 10 - count };
}

async function incrementUsage(userId) {
  await pool.query(
    'UPDATE users SET reports_this_month = reports_this_month + 1 WHERE user_id = $1',
    [userId]
  );
}

app.post('/api/generate', async (req, res) => {
  const { transcript, stage, dealName, dealValue } = req.body;
  const userId = req.ip;
  
  const usage = await checkUsageLimit(userId);
  
  if (!usage.allowed) {
    return res.status(429).json({ 
      error: 'Monthly limit reached',
      message: 'You have used your 10 free reports this month.'
    });
  }
  
  const systemPrompt = `You are PipeNote, an expert sales intelligence assistant. Your job is to analyze sales call transcripts and produce structured, copy-paste-ready CRM updates.

You think like a seasoned sales manager reviewing a call. You understand deal stages, buying signals, risk indicators, and objection patterns.

CRITICAL RULE: You are stage-aware. Every risk flag and missing information alert must be calibrated to the deal stage. Something missing in a Discovery call is often completely normal. The same thing missing in a Negotiation call is a serious red flag.

Your output is always structured, consistent, and actionable.`;

  const userPrompt = `Analyze the following sales call transcript and produce a full PipeNote report.

TRANSCRIPT:
${transcript}

${dealName ? `Deal name: ${dealName}` : ''}
${stage ? `Stated stage: ${stage}` : 'Infer the stage from the transcript'}
${dealValue ? `Deal value: ${dealValue}` : ''}

Produce the report in this exact structure:

PIPENOTE REPORT

## 1. DEAL SNAPSHOT

One-line summary: [Who, what, where they are in the process]
Call type: [Discovery / Demo / Evaluation / Negotiation / Closing / Follow-up]
Inferred stage: [Stage name] - [one sentence explaining signals]
Deal health: [Strong / Uncertain / At risk] - [one sentence reason]
Recommended CRM stage: [Stage name] - [one sentence justification]
Stage movement: [Move forward / Hold / Move back] - [why]

---

## 2. RISK FLAGS
Calibrated to: [Stage name]

Only flag risks meaningful at this stage. For each risk:
- [Risk type]: [Specific evidence from transcript]
  Severity: [High / Medium / Low] - [why it matters now]

ALWAYS flag: (1) COMPETITOR MENTIONED, (2) PRODUCT FIT CONCERN

If no risks: "No significant risks detected."

---

## 3. OBJECTIONS RAISED

For each:
- Objection: [What prospect said]
  How handled: [What rep said]
  Status: [Resolved / Partially addressed / Unresolved / Not addressed]

---

## 4. NEXT STEPS

- [Action] - Owner: [Rep / Prospect / Both] - Due: [Date or TBD]

Next step discipline: [Strong / Weak / None committed]

---

## 5. MISSING INFORMATION ALERTS
Calibrated to: [Stage name]

For each:
- [Missing item]: [Why it matters] - [Suggested question]

---

## 6. CRM UPDATE BLOCKS

SALESFORCE

Activity Subject: [Prospect Name] - [Call Type] - [Date]
Call Result: Completed
Description: [3-5 sentences for manager]

Next Step: [Most important action]
Next Step Date: [Date / TBD]
Stage: [Recommended stage]
Close Date: [If mentioned / TBD]
Amount: [If mentioned / No change]

Notes:
- Topics: [bullets]
- Signals: [bullets]
- Risks: [bullets]
- Open questions: [bullets]

---

HUBSPOT

Log Activity: Call - Connected
Call Title: [Prospect Name] - [Call Type] - [Date]
Call Notes: [3-5 sentences]

Deal Stage: [Recommended stage]
Close Date: [If mentioned / TBD]
Deal Amount: [If mentioned / No change]
Next Activity: [Next step]
Next Activity Date: [Date / TBD]

Deal Notes:
- Topics: [bullets]
- Signals: [bullets]
- Risks: [bullets]

---

GENERIC

Summary: [3-5 sentences]
Stage: [Stage] - [Reason]
Deal Health: [Strong / Uncertain / At risk]
Topics discussed: [bullets]
Positive signals: [bullets]
Concerning signals: [bullets]
Risks: [bullets]
Next steps: [bullets with owners]
Missing info: [bullets]

---

## 7. COACH'S CORNER
For a [Stage] call

[2-4 sentences. Lead with what went well, then one constructive suggestion.]

END OF PIPENOTE REPORT`;

  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    const stream = await anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      temperature: 0.2,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`);
      }
    }
    
    await incrementUsage(userId);
    res.write(`data: ${JSON.stringify({ done: true, remaining: usage.remaining - 1 })}\n\n`);
    res.end();
    
  } catch (err) {
    console.error('Error:', err);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));