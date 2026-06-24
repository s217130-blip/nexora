import express from "express";
import path from "path";
import OpenAI from "openai";
import { createServer as createViteServer } from "vite";

const app = express();
const PORT = 3000;

// Initialize OpenAI SDK safely
let aiInstance: OpenAI | null = null;
function getAI(): OpenAI {
  if (!aiInstance) {
    let envKey = process.env.OPENROUTER_API_KEY?.trim() || "";
    if (envKey && !envKey.startsWith("sk-or-")) envKey = "";
    const apiKey = envKey || "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";
    aiInstance = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey,
      defaultHeaders: {
        "HTTP-Referer": "https://aistudio.google.com/",
        "X-Title": "AI Studio Applet",
      }
    });
  }
  return aiInstance;
}

app.use(express.json());

// Simple in-memory memory storage for dictionary cache, quiz attempts, and learning tasks so they persist within the server lifecycle
const dictionaryCache = new Map<string, any>();
const quizAttempts: any[] = [];
const tasksStorage: any[] = [
  {
    id: "init-1",
    title: "了解自我多益起點 (限時 Part 5 出題 5 題)",
    category: "測驗練習",
    dueDate: "2026-06-21",
    completedAt: null,
    createdAt: new Date().toISOString()
  },
  {
    id: "init-2",
    title: "利用單字掃描查詢 5 個常見商業會議術語 (如: adjourn, schedule, agenda)",
    category: "單字學習",
    dueDate: "2026-06-21",
    completedAt: null,
    createdAt: new Date().toISOString()
  },
  {
    id: "init-3",
    title: "與 Nexora 助理討論如何安排 14 天衝刺讀書計畫",
    category: "AI 諮詢",
    dueDate: "2026-06-22",
    completedAt: null,
    createdAt: new Date().toISOString()
  }
];

// Helper to sanitize words
function getCleanWord(word: any): string {
  return String(word || "").trim().toLowerCase();
}

/**
 * 1. POST /api/dictionary/search
 * Analyzes English word via Gemini AI customized for Taiwanese TOEIC learners.
 */
app.post("/api/dictionary/search", async (req, res) => {
  const { word } = req.body;
  const cleanWord = getCleanWord(word);

  if (!cleanWord || !/^[a-zA-Z\s-]+$/.test(cleanWord)) {
    return res.status(400).json({ error: "請輸入有效的英文單字或片語（僅限英文字母及空格）" });
  }

  // Check cache first
  if (dictionaryCache.has(cleanWord)) {
    return res.json({ hit: true, entry: dictionaryCache.get(cleanWord) });
  }

  try {
    const ai = getAI();
    const prompt = `You are Nexora's professional TOEIC dictionary engine.
Analyze the English word or phrase: "${cleanWord}".
Strict Rules:
1. Provide translation and explanations ONLY in Taiwan Traditional Chinese (繁體中文).
2. Prioritize workplace, business, official, travel contexts fitting TOEIC.
3. Keep definitions precise, helpful, and natural.
4. You must format your response exactly according to the provided schema.

Return structured JSON data only. Include:
- word: the queried word.
- phonetic: KK phonetic symbol or general pronunciation guide (e.g. /kɑ́nfərəns/).
- toeicFreq: high, medium, or low TOEIC exam frequency.
- meanings: array of objects with part of speech (pos, e.g. "n.", "v.", "adj.") and definitions (zhDef in Traditional Chinese, engDef in English).
- examples: array of high-quality TOEIC-style business sentences (eng) with Taiwan Traditional Chinese translation (zht), and context tags (tag, e.g. "business", "meeting", "logistics").
- collocations: 2-3 common collocations or phrases related to this word in TOEIC.
- rootAnalysis: a short breakdown of its prefix, suffix, or root (in Traditional Chinese) to aid memory constraint.`;

    const response = await ai.chat.completions.create({
      model: "google/gemini-2.5-flash",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_tokens: 4000
    });

    const parsedData = JSON.parse(response.choices[0].message.content || "{}");
    dictionaryCache.set(cleanWord, parsedData);
    res.json({ hit: false, entry: parsedData });
  } catch (err: any) {
    console.error("Dictionary Search error:", err);
    res.status(500).json({ error: err.message || "單字分析失敗，請檢查 API 金鑰與網路連線" });
  }
});

/**
 * 2. GET /api/dictionary/cache/:word
 * Checks if search is cached.
 */
app.get("/api/dictionary/cache/:word", (req, res) => {
  const cleanWord = getCleanWord(req.params.word);
  if (dictionaryCache.has(cleanWord)) {
    res.json({ hit: true, entry: dictionaryCache.get(cleanWord) });
  } else {
    res.json({ hit: false, entry: null });
  }
});

/**
 * 3. POST /api/quiz/generate
 * Generates one TOEIC Part 5 multiple choice question dynamically via Gemini AI.
 */
app.post("/api/quiz/generate", async (req, res) => {
  const { category, difficulty, weakness } = req.body;

  const currentCategory = String(category || "商務會議");
  const currentDiff = String(difficulty || "medium");
  const currentWeakness = String(weakness || "一般多益文法與詞彙");

  try {
    const ai = getAI();
    const prompt = `You are Nexora's smart TOEIC Part 5 items generation engine.
Generate a high-quality single-sentence multiple-choice completion question based on the criteria below:
- Context topic: ${currentCategory}
- Difficulty Level: ${currentDiff}
- Target Learner weakness to target: ${currentWeakness}

Strict Rules:
1. Ensure there is EXACTLY ONE clearly correct option out of A, B, C, D. All other three must be plausible grammatical or lexical distractors.
2. The options object must contain A, B, C, D exactly.
3. The translation, explanation, and vocabulary assistance MUST be provided in high-quality Taiwan Traditional Chinese (繁體中文).
4. Do not prefix choices with original indices inside option values. Keep options clean.
5. Identify a specific TOEIC skill test point (e.g. passive voice, conjunction, gerund, word choice).

Please return JSON formatted strictly to the specified schema.`;

    const response = await ai.chat.completions.create({
      model: "google/gemini-2.5-flash",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_tokens: 4000
    });

    const parsedData = JSON.parse(response.choices[0].message.content || "{}");
    res.json(parsedData);
  } catch (err: any) {
    console.error("Quiz Generate error:", err);
    res.status(500).json({ error: err.message || "智能出題失敗，請檢查 API 金鑰與網路連線" });
  }
});

/**
 * 4. POST /api/quiz/attempt
 * Saves quiz response.
 */
app.post("/api/quiz/attempt", (req, res) => {
  const { questionId, questionText, chosenAnswer, correctAnswer, correct, skill } = req.body;
  const newAttempt = {
    id: `attempt-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    questionId: questionId || "dynamic",
    questionText,
    chosenAnswer,
    correctAnswer,
    correct: Boolean(correct),
    skill: skill || "一般字彙",
    createdAt: new Date().toISOString()
  };
  quizAttempts.push(newAttempt);
  res.json({ success: true, saved: true, record: newAttempt });
});

/**
 * 5. GET /api/quiz/stats
 * Helper stats endpoint for the backend overview tab
 */
app.get("/api/quiz/stats", (req, res) => {
  const total = quizAttempts.length;
  const correctCount = quizAttempts.filter(a => a.correct).length;
  const correctRate = total > 0 ? Math.round((correctCount / total) * 100) : 100;

  // Breakdown by skills
  const skillStats: Record<string, { total: number; correct: number }> = {};
  quizAttempts.forEach(a => {
    const s = a.skill || "一般文法";
    if (!skillStats[s]) skillStats[s] = { total: 0, correct: 0 };
    skillStats[s].total += 1;
    if (a.correct) skillStats[s].correct += 1;
  });

  res.json({
    total,
    correctCount,
    correctRate,
    history: quizAttempts.slice(-10),
    skillBreakdown: Object.entries(skillStats).map(([skill, stat]) => ({
      skill,
      total: stat.total,
      correct: stat.correct,
      rate: Math.round((stat.correct / stat.total) * 100)
    }))
  });
});

/**
 * 6. POST /api/assistant
 * Rich AI multi-turn conversational service customized as a TOEIC coach.
 */
app.post("/api/assistant", async (req, res) => {
  const { message, history } = req.body;
  const userMessage = String(message || "").trim();

  if (!userMessage) {
    return res.status(400).json({ error: "提問內容不能為空" });
  }

  try {
    const ai = getAI();

    // Prepare message history formatted for Gemini
    // Input history consists of [{ role: "user" | "model", content: "string" }]
    // We map this into { role: "user" | "model", parts: [{ text: "..." }] }
    const geminiContents: any[] = [];

    if (Array.isArray(history)) {
      history.forEach((h: any) => {
        if (h.role && h.content) {
          geminiContents.push({
            role: h.role === "user" ? "user" : "model",
            parts: [{ text: h.content }]
          });
        }
      });
    }

    // Append current user message
    geminiContents.push({
      role: "user",
      parts: [{ text: userMessage }]
    });

    const systemInstruction = `You are Nexora AI, a friendly, authoritative, and helpful TOEIC Learning Coach for Taiwanese students.
Strict directives:
1. Always reply in fluent, comforting, and natural Taiwan Traditional Chinese (繁體中文).
2. Specialized in explaining English grammar, word nuances (such as "conference" vs "convention"), reading hacks, vocabulary triggers, or study schedules.
3. Keep formatting clean and highly readable using markdown lists and bold accents. Break down answers into logical chunks.
4. Provide immediate, practical studying suggestions or memorization tips (e.g., word roots, prefixes, visual associations).
5. Ensure a supportive, encouragement-focused pedagogical tone to reduce student anxiety.`;

    const response = await ai.chat.completions.create({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: systemInstruction },
        ...geminiContents.map((c: any) => ({ role: (c.role === "model" ? "assistant" : "user") as any, content: c.parts[0].text }))
      ],
      temperature: 0.7,
      max_tokens: 4000
    });

    const reply = response.choices[0].message.content || "非常抱歉，我暫時無法正常回覆。請再試一次。";
    res.json({ reply });
  } catch (err: any) {
    console.error("AI Assistant error:", err);
    res.status(500).json({ error: err.message || "發生未知錯誤" });
  }
});

/**
 * 7. POST /api/assistant/summary
 * Provides a diagnostic summary of the user's progress.
 */
app.post("/api/assistant/summary", async (req, res) => {
  const { profile, tasks, attempts } = req.body;
  
  try {
    const ai = getAI();
    const prompt = `You are Nexora AI Coach's diagnostic summarization system.
Analyze TOEIC student metrics:
- Profile: ${JSON.stringify(profile || {})}
- Ongoing/Completed Tasks: ${JSON.stringify(tasks || [])}
- Question Attempt Records (Part 5): ${JSON.stringify(attempts || [])}
Strict Rules:
1. Answer ONLY in Taiwan Traditional Chinese (繁體中文).
2. Generate an encouraging, personalized summary, plus specific bullet points for weaknesses and strategic next steps.
3. Formulate the response strictly to the schema provided.`;

    const response = await ai.chat.completions.create({
      model: "google/gemini-2.5-flash",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_tokens: 4000
    });

    const parsedData = JSON.parse(response.choices[0].message.content || "{}");
    res.json(parsedData);
  } catch (err: any) {
    console.error("AI Summary error:", err);
    res.status(500).json({ error: err.message || "診斷產生失敗" });
  }
});

/**
 * 8. GET & POST /api/tasks
 * Dynamic management of study actions that synchronizes to the front-panel.
 */
app.get("/api/tasks", (req, res) => {
  res.json({ tasks: tasksStorage });
});

app.post("/api/tasks", (req, res) => {
  const { title, category, dueDate } = req.body;
  if (!title) {
    return res.status(400).json({ error: "任務標題為必填欄位" });
  }

  const newTask = {
    id: `task-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    title: String(title).slice(0, 150),
    category: String(category || "一般").slice(0, 50),
    dueDate: String(dueDate || new Date().toISOString().slice(0, 10)),
    completedAt: null,
    createdAt: new Date().toISOString()
  };

  tasksStorage.push(newTask);
  res.json({ success: true, task: newTask });
});

// Complete specific task
app.post("/api/tasks/toggle", (req, res) => {
  const { id } = req.body;
  const task = tasksStorage.find(t => t.id === id);
  if (task) {
    task.completedAt = task.completedAt ? null : new Date().toISOString();
    return res.json({ success: true, task });
  }
  res.status(404).json({ error: "找不到該任務" });
});

// Delete task
app.post("/api/tasks/delete", (req, res) => {
  const { id } = req.body;
  const index = tasksStorage.findIndex(t => t.id === id);
  if (index !== -1) {
    const deleted = tasksStorage.splice(index, 1);
    return res.json({ success: true, task: deleted[0] });
  }
  res.status(404).json({ error: "找不到該任務" });
});


// 9. Vite Dev Server and Static Assets integration
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    console.log("Starting server in DEVELOPMENT mode with Vite Middleware...");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("Starting server in PRODUCTION mode...");
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Nexora backend is live on port ${PORT}!`);
  });
}

startServer();
