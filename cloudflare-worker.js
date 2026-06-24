const DEFAULT_TASKS = [
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
        title: "利用單字智慧掃描查詢 5 個常見商業會議術語 (如: adjourn, schedule, agenda)",
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
// Transient local cache for edge isolates
const dictionaryCache = new Map();
let localQuizAttempts = [];
let localTasksStorage = [...DEFAULT_TASKS];
// Unified storage retrieval
async function getTasks(env) {
    if (env.NEXORA_KV) {
        const data = await env.NEXORA_KV.get("tasks");
        if (data) {
            try {
                return JSON.parse(data);
            }
            catch (e) {
                return DEFAULT_TASKS;
            }
        }
    }
    return localTasksStorage;
}
async function saveTasks(env, tasks) {
    if (env.NEXORA_KV) {
        await env.NEXORA_KV.put("tasks", JSON.stringify(tasks));
    }
    else {
        localTasksStorage = tasks;
    }
}
async function getAttempts(env) {
    if (env.NEXORA_KV) {
        const data = await env.NEXORA_KV.get("attempts");
        if (data) {
            try {
                return JSON.parse(data);
            }
            catch (e) {
                return [];
            }
        }
    }
    return localQuizAttempts;
}
async function saveAttempts(env, attempts) {
    if (env.NEXORA_KV) {
        await env.NEXORA_KV.put("attempts", JSON.stringify(attempts));
    }
    else {
        localQuizAttempts = attempts;
    }
}
// REST helper for Gemini Content Generation API
async function generateGeminiContent(apiKey, body) {
    const model = "gemini-2.0-flash"; // Aligning with developer server model
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "User-Agent": "cloudflare-pages-function"
        },
        body: JSON.stringify(body)
    });
    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API Error: ${response.status} - ${errText}`);
    }
    const data = await response.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
        throw new Error("Gemini returned empty candidate content response");
    }
    return rawText;
}
function corsResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json;charset=UTF-8",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
    });
}
export const onRequest = async (context) => {
    const { request, env } = context;
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    // Handle preflight OPTIONS
    if (method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization"
            }
        });
    }
    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey && path.includes("/api") && method !== "OPTIONS") {
        // If user forgot to define GEMINI_API_KEY in Cloudflare Environment variables
        if (path === "/api/tasks" || path === "/api/quiz/stats") {
            // Allow general list read tasks and stats without key to avoid total layout breakage
        }
        else {
            return corsResponse({
                error: "忘記設定 Cloudflare 環境變數 GEMINI_API_KEY！請前往 Cloudflare Dash -> Pages -> Settings -> Environment variables 新增配置。"
            }, 500);
        }
    }
    try {
        // 1. POST /api/dictionary/search
        if (path === "/api/dictionary/search" && method === "POST") {
            const { word } = await request.json();
            const cleanWord = String(word || "").trim().toLowerCase();
            if (!cleanWord || !/^[a-zA-Z\s-]+$/.test(cleanWord)) {
                return corsResponse({ error: "請輸入有效的英文單字或片語" }, 400);
            }
            // Read from isolate memory cache first
            if (dictionaryCache.has(cleanWord)) {
                return corsResponse({ hit: true, entry: dictionaryCache.get(cleanWord) });
            }
            const prompt = `You are Nexora's professional TOEIC dictionary engine.
Analyze the English word or phrase: "${cleanWord}".
Strict Rules:
1. Provide translation and explanations ONLY in Taiwan Traditional Chinese (繁體中文).
2. Prioritize workplace, business, official, travel contexts fitting TOEIC.
3. Formulate response in detailed JSON.`;
            const responseSchema = {
                type: "OBJECT",
                required: ["word", "phonetic", "toeicFreq", "meanings", "examples"],
                properties: {
                    word: { type: "STRING" },
                    phonetic: { type: "STRING" },
                    toeicFreq: { type: "STRING" },
                    meanings: {
                        type: "ARRAY",
                        items: {
                            type: "OBJECT",
                            required: ["pos", "zhDef", "engDef"],
                            properties: {
                                pos: { type: "STRING" },
                                zhDef: { type: "STRING" },
                                engDef: { type: "STRING" }
                            }
                        }
                    },
                    examples: {
                        type: "ARRAY",
                        items: {
                            type: "OBJECT",
                            required: ["eng", "zht", "tag"],
                            properties: {
                                eng: { type: "STRING" },
                                zht: { type: "STRING" },
                                tag: { type: "STRING" }
                            }
                        }
                    },
                    collocations: {
                        type: "ARRAY",
                        items: { type: "STRING" }
                    },
                    rootAnalysis: { type: "STRING" }
                }
            };
            const resultText = await generateGeminiContent(apiKey, {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    responseMimeType: "application/json",
                    responseSchema
                }
            });
            const entry = JSON.parse(resultText);
            dictionaryCache.set(cleanWord, entry);
            return corsResponse({ hit: false, entry });
        }
        // 2. GET /api/dictionary/cache/:word
        if (path.startsWith("/api/dictionary/cache/") && method === "GET") {
            const parts = path.split("/");
            const word = decodeURIComponent(parts[parts.length - 1] || "");
            const cleanWord = word.trim().toLowerCase();
            if (dictionaryCache.has(cleanWord)) {
                return corsResponse({ hit: true, entry: dictionaryCache.get(cleanWord) });
            }
            return corsResponse({ hit: false, entry: null });
        }
        // 3. POST /api/quiz/generate
        if (path === "/api/quiz/generate" && method === "POST") {
            const { category, difficulty, weakness } = await request.json();
            const currentCategory = category || "商務會議";
            const currentDiff = difficulty || "medium";
            const currentWeakness = weakness || "一般多益文法與詞彙";
            const prompt = `You are Nexora's smart TOEIC Part 5 items generation engine.
Generate a high-quality single-sentence multiple-choice completion question based on:
- Context topic: ${currentCategory}
- Difficulty Level: ${currentDiff}
- Weakness point: ${currentWeakness}
Return Taiwan Traditional Chinese (繁體中文). options strictly with A,B,C,D.`;
            const responseSchema = {
                type: "OBJECT",
                required: ["question", "options", "answer", "translation", "explanation", "skill", "difficulty"],
                properties: {
                    question: { type: "STRING" },
                    options: {
                        type: "OBJECT",
                        required: ["A", "B", "C", "D"],
                        properties: {
                            A: { type: "STRING" },
                            B: { type: "STRING" },
                            C: { type: "STRING" },
                            D: { type: "STRING" }
                        }
                    },
                    answer: { type: "STRING" },
                    translation: { type: "STRING" },
                    explanation: { type: "STRING" },
                    skill: { type: "STRING" },
                    difficulty: { type: "STRING" },
                    vocabTips: {
                        type: "ARRAY",
                        items: { type: "STRING" }
                    }
                }
            };
            const resultText = await generateGeminiContent(apiKey, {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    responseMimeType: "application/json",
                    responseSchema
                }
            });
            return corsResponse(JSON.parse(resultText));
        }
        // 4. POST /api/quiz/attempt
        if (path === "/api/quiz/attempt" && method === "POST") {
            const { questionId, questionText, chosenAnswer, correctAnswer, correct, skill } = await request.json();
            const attempts = await getAttempts(env);
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
            attempts.push(newAttempt);
            await saveAttempts(env, attempts);
            return corsResponse({ success: true, saved: true, record: newAttempt });
        }
        // 5. GET /api/quiz/stats
        if (path === "/api/quiz/stats" && method === "GET") {
            const attempts = await getAttempts(env);
            const total = attempts.length;
            const correctCount = attempts.filter((a) => a.correct).length;
            const correctRate = total > 0 ? Math.round((correctCount / total) * 100) : 100;
            const skillStats = {};
            attempts.forEach((a) => {
                const s = a.skill || "一般文法";
                if (!skillStats[s])
                    skillStats[s] = { total: 0, correct: 0 };
                skillStats[s].total += 1;
                if (a.correct)
                    skillStats[s].correct += 1;
            });
            return corsResponse({
                total,
                correctCount,
                correctRate,
                history: attempts.slice(-10),
                skillBreakdown: Object.entries(skillStats).map(([skill, stat]) => ({
                    skill,
                    total: stat.total,
                    correct: stat.correct,
                    rate: Math.round((stat.correct / stat.total) * 100)
                }))
            });
        }
        // 6. POST /api/assistant
        if (path === "/api/assistant" && method === "POST") {
            const { message, history } = await request.json();
            const userMessage = String(message || "").trim();
            if (!userMessage) {
                return corsResponse({ error: "提問內容不能為空" }, 400);
            }
            const geminiContents = [];
            if (Array.isArray(history)) {
                history.forEach((h) => {
                    if (h.role && h.content) {
                        geminiContents.push({
                            role: h.role === "user" ? "user" : "model",
                            parts: [{ text: h.content }]
                        });
                    }
                });
            }
            geminiContents.push({
                role: "user",
                parts: [{ text: userMessage }]
            });
            const systemInstructionText = `You are Nexora AI, a friendly, authoritative, and helpful TOEIC Learning Coach for Taiwanese students.
Always reply in fluent, comforting, and natural Taiwan Traditional Chinese (繁體中文).`;
            const resultText = await generateGeminiContent(apiKey, {
                contents: geminiContents,
                systemInstruction: {
                    parts: [{ text: systemInstructionText }]
                },
                generationConfig: {
                    temperature: 0.7
                }
            });
            return corsResponse({ reply: resultText });
        }
        // 7. POST /api/assistant/summary
        if (path === "/api/assistant/summary" && method === "POST") {
            const { profile, tasks, attempts } = await request.json();
            const prompt = `You are Nexora AI Coach's diagnostic summarization system.
Analyze TOEIC student metrics:
- Profile: ${JSON.stringify(profile || {})}
- Ongoing/Completed Tasks: ${JSON.stringify(tasks || [])}
- Question Attempt Records (Part 5): ${JSON.stringify(attempts || [])}
Return Taiwan Traditional Chinese (繁體中文).`;
            const responseSchema = {
                type: "OBJECT",
                required: ["weaknesses", "nextTasks", "summary"],
                properties: {
                    weaknesses: {
                        type: "ARRAY",
                        items: { type: "STRING" }
                    },
                    nextTasks: {
                        type: "ARRAY",
                        items: { type: "STRING" }
                    },
                    summary: { type: "STRING" }
                }
            };
            const resultText = await generateGeminiContent(apiKey, {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    responseMimeType: "application/json",
                    responseSchema
                }
            });
            return corsResponse(JSON.parse(resultText));
        }
        // 8. GET & POST /api/tasks
        if (path === "/api/tasks" && method === "GET") {
            const tasks = await getTasks(env);
            return corsResponse({ tasks });
        }
        if (path === "/api/tasks" && method === "POST") {
            const { title, category, dueDate } = await request.json();
            if (!title) {
                return corsResponse({ error: "任務標題為必填欄位" }, 400);
            }
            const tasks = await getTasks(env);
            const newTask = {
                id: `task-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
                title: String(title).slice(0, 150),
                category: String(category || "一般").slice(0, 50),
                dueDate: String(dueDate || new Date().toISOString().slice(0, 10)),
                completedAt: null,
                createdAt: new Date().toISOString()
            };
            tasks.push(newTask);
            await saveTasks(env, tasks);
            return corsResponse({ success: true, task: newTask });
        }
        // Toggle specific task
        if (path === "/api/tasks/toggle" && method === "POST") {
            const { id } = await request.json();
            const tasks = await getTasks(env);
            const task = tasks.find((t) => t.id === id);
            if (task) {
                task.completedAt = task.completedAt ? null : new Date().toISOString();
                await saveTasks(env, tasks);
                return corsResponse({ success: true, task });
            }
            return corsResponse({ error: "找不到該任務" }, 404);
        }
        // Delete specific task
        if (path === "/api/tasks/delete" && method === "POST") {
            const { id } = await request.json();
            const tasks = await getTasks(env);
            const index = tasks.findIndex((t) => t.id === id);
            if (index !== -1) {
                const deleted = tasks.splice(index, 1)[0];
                await saveTasks(env, tasks);
                return corsResponse({ success: true, task: deleted });
            }
            return corsResponse({ error: "找不到該任務" }, 404);
        }
        // Fallback 404 for unhandled API endpoints
        return corsResponse({ error: "Not Found" }, 404);
    }
    catch (err) {
        return corsResponse({ error: err.message || "Edge Server Error" }, 500);
    }
};

export default {
  async fetch(request, env, ctx) {
    return onRequest({ request, env });
  }
};
