const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const client = require("prom-client");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const Redis = require("ioredis");
const { htmlToText } = require("html-to-text");
const fs = require("fs");
require("dotenv").config();

const app = express();
// Trust only the first proxy (e.g., Nginx) to prevent permissive trust proxy issues
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3001;
const SESSION_TOKEN_SECRET =
  process.env.SESSION_TOKEN_SECRET || "dev-session-token-secret-change-me";
const MAX_DAILY_REQUESTS = Number(process.env.AI_DAILY_LIMIT || 50);
const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379/0";
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || "";
// When set to 'false', Turnstile verification is bypassed and sessions are issued
// without requiring a Turnstile token. Default is required (true) unless explicitly disabled.
const TURNSTILE_REQUIRED =
  (process.env.TURNSTILE_REQUIRED || "true") !== "false";
const ARACHNE_URL = process.env.ARACHNE_URL || "http://arachne:8080";
const ARACHNE_API_TOKEN = process.env.ARACHNE_API_TOKEN || "";
const PROFILE_CONTEXT_PATH = process.env.PROFILE_CONTEXT_PATH || "";
const PROFILE_CONTEXT_INLINE = process.env.PROFILE_CONTEXT || "";
const SCRAPE_POLL_MAX_SECONDS = Number(
  process.env.SCRAPE_POLL_MAX_SECONDS || 75
);
const SCRAPE_POLL_INITIAL_MS = Number(
  process.env.SCRAPE_POLL_INITIAL_MS || 1200
);
const SCRAPE_POLL_MAX_MS = Number(process.env.SCRAPE_POLL_MAX_MS || 6000);
const SCRAPE_POLL_BACKOFF_MULT = Number(
  process.env.SCRAPE_POLL_BACKOFF_MULT || 1.35
);

// Redis client (used for per-IP/day quotas)
const redis = new Redis(REDIS_URL);
redis.on("error", (err) => {
  console.error("Redis error:", err);
});

// Initialize Prometheus metrics
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics({ prefix: "ai_backend_" });

// Create custom metrics
const httpRequestDurationMicroseconds = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.1, 0.5, 1, 2, 5],
});

const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"],
});

const aiChatRequestsTotal = new client.Counter({
  name: "ai_chat_requests_total",
  help: "Total number of AI chat requests",
  labelNames: ["status"],
});

const aiChatResponseTime = new client.Histogram({
  name: "ai_chat_response_time_seconds",
  help: "AI chat response time in seconds",
  buckets: [0.1, 0.5, 1, 2, 5, 10],
});

// Initialize Google Generative AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Helper: generate text with a custom token budget
async function generateWithConfig(prompt, maxTokens = 1000, temperature = 0.7) {
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash-latest",
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
    },
  });
  const result = await model.generateContent(prompt);
  const response = result.response;
  return response.text();
}

// Middleware
// Configurable CORS: use env vars if provided, otherwise sensible defaults
const corsAllowOrigin =
  process.env.CORS_ALLOW_ORIGIN ||
  (process.env.NODE_ENV === "production" ? "same-origin" : "*");
const corsAllowMethods = (process.env.CORS_ALLOW_METHODS || "GET,POST,OPTIONS")
  .split(/[,\s]+/)
  .filter(Boolean);
const corsAllowHeaders = (
  process.env.CORS_ALLOW_HEADERS ||
  "DNT,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range,Authorization"
)
  .split(/[,\s]+/)
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow same-origin and server-to-server requests
      if (
        !origin ||
        corsAllowOrigin === "*" ||
        corsAllowOrigin === "same-origin"
      ) {
        return callback(null, true);
      }
      // Support comma-separated origins
      const allowed = corsAllowOrigin.split(/[,\s]+/).filter(Boolean);
      if (allowed.includes(origin)) return callback(null, true);
      return callback(new Error("CORS not allowed"));
    },
    credentials: false,
    methods: corsAllowMethods,
    allowedHeaders: corsAllowHeaders,
  })
);
app.use(helmet());
app.use(express.json({ limit: "1mb" }));

// Basic rate limiting (second layer; nginx is first layer)
const RATE_LIMIT_WINDOW_MS = Number(
  process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000
);
const RATE_LIMIT_MAX_REQUESTS = Number(
  process.env.RATE_LIMIT_MAX_REQUESTS || 100
);
const limiter = rateLimit({
  windowMs: Number.isFinite(RATE_LIMIT_WINDOW_MS)
    ? RATE_LIMIT_WINDOW_MS
    : 15 * 60 * 1000,
  max: Number.isFinite(RATE_LIMIT_MAX_REQUESTS) ? RATE_LIMIT_MAX_REQUESTS : 100,
  standardHeaders: true,
  legacyHeaders: false,
});

// Metrics middleware
app.use((req, res, next) => {
  const start = Date.now();

  res.on("finish", () => {
    const duration = (Date.now() - start) / 1000;
    const labels = {
      method: req.method,
      route: req.route ? req.route.path : req.path,
      status_code: res.statusCode,
    };

    httpRequestDurationMicroseconds.observe(labels, duration);
    httpRequestsTotal.inc(labels);
  });

  next();
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Metrics endpoint
app.get("/metrics", async (req, res) => {
  try {
    res.set("Content-Type", client.register.contentType);
    res.end(await client.register.metrics());
  } catch (ex) {
    res.status(500).end(ex);
  }
});

// Utility helpers
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollScrapeStatus(jobId, headers) {
  const deadline = Date.now() + SCRAPE_POLL_MAX_SECONDS * 1000;
  let delay = SCRAPE_POLL_INITIAL_MS;
  let lastJob = null;
  while (Date.now() < deadline) {
    try {
      const statusResp = await axios.get(
        `${ARACHNE_URL.replace(/\/$/, "")}/scrape/status`,
        { params: { id: jobId }, headers, timeout: 10000 }
      );
      lastJob = statusResp.data?.job || null;
      const st = lastJob?.status;
      if (st === "completed" || st === "failed" || st === "error") {
        return lastJob;
      }
    } catch (e) {
      // Network or transient error; continue with backoff
    }
    await sleep(delay);
    delay = Math.min(
      Math.floor(delay * SCRAPE_POLL_BACKOFF_MULT),
      SCRAPE_POLL_MAX_MS
    );
  }
  return lastJob;
}

function getClientIp(req) {
  const xfwd = req.headers["x-forwarded-for"]; // e.g. "client, proxy1, proxy2"
  if (xfwd) return xfwd.split(",")[0].trim();
  return req.ip || req.connection?.remoteAddress || "unknown";
}

function todayKeyForIp(ip) {
  const now = new Date();
  const day = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(
    2,
    "0"
  )}${String(now.getUTCDate()).padStart(2, "0")}`;
  return `ai_quota:${ip}:${day}`;
}

async function incrementDailyQuota(ip) {
  const key = todayKeyForIp(ip);
  const count = await redis.incr(key);
  if (count === 1) {
    // set TTL until midnight UTC
    const now = new Date();
    const tomorrow = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
    );
    const ttlSeconds = Math.max(60, Math.floor((tomorrow - now) / 1000));
    await redis.expire(key, ttlSeconds);
  }
  return count;
}

function signSessionToken(payload) {
  return jwt.sign(payload, SESSION_TOKEN_SECRET, { expiresIn: "1d" });
}

function verifySessionToken(token) {
  try {
    return jwt.verify(token, SESSION_TOKEN_SECRET);
  } catch (e) {
    return null;
  }
}

// Profile context for recruiter fit assessments
let cachedProfileContext = null;
function getProfileContext() {
  if (cachedProfileContext !== null) return cachedProfileContext;
  try {
    if (PROFILE_CONTEXT_PATH && fs.existsSync(PROFILE_CONTEXT_PATH)) {
      cachedProfileContext = fs
        .readFileSync(PROFILE_CONTEXT_PATH, "utf8")
        .trim();
      return cachedProfileContext;
    }
  } catch (e) {
    console.warn("Unable to read PROFILE_CONTEXT_PATH:", e.message);
  }
  if (PROFILE_CONTEXT_INLINE) {
    cachedProfileContext = String(PROFILE_CONTEXT_INLINE);
  } else {
    cachedProfileContext =
      "Kareem Sasa: Senior software engineer experienced in TypeScript, React, Node.js, Go, distributed systems, DevOps (Docker, Compose, Nginx), CI/CD, and system design. Built Workfolio (this portfolio), AI backend integrations, and Arachne (Go-based scraper).";
  }
  return cachedProfileContext;
}

// Turnstile verification + session token issuance
app.post("/auth/turnstile", async (req, res) => {
  try {
    const { token } = req.body || {};
    const ip = getClientIp(req);

    // If Turnstile is not required (explicitly disabled), issue a session token
    if (!TURNSTILE_REQUIRED) {
      const bypassToken = signSessionToken({
        ip,
        bypass: true,
        iat: Date.now(),
      });
      return res.json({ sessionToken: bypassToken });
    }

    // In non-production without a secret, issue a dev token
    if (process.env.NODE_ENV !== "production" && !TURNSTILE_SECRET) {
      const devToken = signSessionToken({ ip, dev: true, iat: Date.now() });
      return res.json({ sessionToken: devToken });
    }

    if (!TURNSTILE_SECRET) {
      return res.status(503).json({ error: "Turnstile not configured" });
    }

    if (!token) {
      return res.status(400).json({ error: "Missing Turnstile token" });
    }

    const params = new URLSearchParams();
    params.append("secret", TURNSTILE_SECRET);
    params.append("response", token);
    params.append("remoteip", ip);

    const verifyResp = await axios.post(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      params,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    if (!verifyResp.data?.success) {
      return res.status(401).json({ error: "Turnstile verification failed" });
    }

    const sessionToken = signSessionToken({ ip });
    return res.json({ sessionToken });
  } catch (err) {
    console.error("Turnstile verification error:", err);
    return res.status(500).json({ error: "Verification error" });
  }
});

// Dev helper to issue a token without Turnstile in non-production
app.post("/auth/dev-token", (req, res) => {
  // Allow dev token in production only if Turnstile is not required
  if (process.env.NODE_ENV === "production" && TURNSTILE_REQUIRED) {
    return res.status(404).end();
  }
  const ip = getClientIp(req);
  const sessionToken = signSessionToken({ ip, dev: true });
  return res.json({ sessionToken });
});

// Chat endpoint
app.post("/chat", limiter, async (req, res) => {
  const startTime = Date.now();

  try {
    const { message, history, context } = req.body || {};

    // Require a session token in production when TURNSTILE is configured
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.substring("Bearer ".length)
      : null;
    if (process.env.NODE_ENV === "production" && TURNSTILE_REQUIRED) {
      const verified = token ? verifySessionToken(token) : null;
      if (!verified) {
        aiChatRequestsTotal.inc({ status: "error" });
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    if (!message) {
      aiChatRequestsTotal.inc({ status: "error" });
      return res.status(400).json({ error: "Message is required" });
    }

    // Check if Gemini API key is configured
    if (!process.env.GEMINI_API_KEY) {
      aiChatRequestsTotal.inc({ status: "error" });
      return res.status(500).json({
        error:
          "AI service not configured. Please set GEMINI_API_KEY environment variable.",
      });
    }

    // Daily quota enforcement (per IP)
    const ip = getClientIp(req);
    let usedToday = 0;
    try {
      usedToday = await incrementDailyQuota(ip);
    } catch (e) {
      console.warn("Quota check failed; allowing request:", e.message);
    }
    if (usedToday > MAX_DAILY_REQUESTS) {
      aiChatRequestsTotal.inc({ status: "error" });
      return res
        .status(429)
        .json({ error: "Daily message limit reached. Please try tomorrow." });
    }

    // Prepare conversation history for Gemini
    const conversationHistory = Array.isArray(history)
      ? history.slice(0, 20).map((m) => ({
          role: m && m.role === "user" ? "user" : "model",
          content:
            typeof m?.content === "string" ? m.content.slice(0, 2000) : "",
          timestamp: Number.isFinite(m?.timestamp) ? m.timestamp : Date.now(),
        }))
      : [];

    // Create the model instance
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash-latest",
    });

    // Start a chat session
    const chat = model.startChat({
      history: conversationHistory.map((msg) => ({
        role: msg.role === "user" ? "user" : "model",
        parts: [{ text: msg.content }],
      })),
      generationConfig: {
        maxOutputTokens: 500,
        temperature: 0.7,
      },
    });

    // Add system context if provided, then always preface with candidate profile
    let fullMessage = String(message).slice(0, 4000);
    if (context) {
      fullMessage = `${String(context).slice(
        0,
        2000
      )}\n\nUser message: ${fullMessage}`;
    }
    const profileForAllChats = getProfileContext();
    const fullMessageWithProfile = `Candidate Profile:\n${profileForAllChats.slice(
      0,
      8000
    )}\n\nUser message: ${fullMessage}`;

    // If the user asks to scrape a URL, orchestrate via Arachne
    const urlRegex = /(https?:\/\/[^\s]+)|(\b[a-z0-9.-]+\.[a-z]{2,}\b)/i;
    const wantsScrape =
      /\b(scrape|fetch|get|extract)\b/i.test(fullMessage) &&
      urlRegex.test(fullMessage);
    // Recruiter-style fit assessment intent (more permissive detection)
    const wantsFitAssessment =
      /\b(qualified|good\s+fit|good\s+candidate|fit)\b/i.test(fullMessage) ||
      /\b(is\s+kareem|am\s+i)\b[\s\S]*\b(good|qualified|fit)\b/i.test(
        fullMessage
      ) ||
      /\bshould\s+i\s+apply\b/i.test(fullMessage);

    if (wantsFitAssessment || wantsScrape) {
      // Extract first URL-like token; sanitize punctuation; if missing scheme, prepend https://
      const stripPunctuation = (s) =>
        String(s || "")
          .trim()
          .replace(/^[“”"'`\(\[\{<]+/, "")
          .replace(/[””"'`\)\]\}>.,;:!?]+$/, "");

      let match = fullMessage.match(urlRegex);
      let target = match ? stripPunctuation(match[0]) : null;
      if (target && !/^https?:\/\//i.test(target)) {
        target = `https://${target}`;
      }

      // Detect pasted job text in the current message (regardless of URL presence)
      let pastedJobText = null;
      {
        const raw = fullMessage.replace(/\s+/g, " ");
        if (raw.length > 600 || /about\s+the\s+job/i.test(fullMessage)) {
          pastedJobText = fullMessage;
        }
      }

      if (target || pastedJobText) {
        try {
          const headers = {};
          if (ARACHNE_API_TOKEN)
            headers["Authorization"] = `Bearer ${ARACHNE_API_TOKEN}`;
          let final = null;
          let jobId = null;
          if (target) {
            const createResp = await axios.post(
              `${ARACHNE_URL.replace(/\/$/, "")}/scrape`,
              { site_url: target },
              { headers, timeout: 15000 }
            );
            jobId = createResp.data?.job_id;

            // Poll status with exponential backoff up to max duration
            final = await pollScrapeStatus(jobId, headers);
          }

          if (final?.status === "completed" || pastedJobText) {
            // Build raw HTML corpus
            const results = pastedJobText
              ? [{ content: pastedJobText }]
              : Array.isArray(final.results)
              ? final.results
              : [];
            const htmlPieces = results
              .map((r) => (typeof r?.content === "string" ? r.content : ""))
              .filter((s) => s && s.length > 0);

            // Chunk safeguards: limit to ~100k chars total
            const MAX_TOTAL = 100_000;
            let total = 0;
            const limitedHtml = [];
            for (const h of htmlPieces) {
              if (total >= MAX_TOTAL) break;
              const remain = MAX_TOTAL - total;
              const part = h.length > remain ? h.slice(0, remain) : h;
              limitedHtml.push(part);
              total += part.length;
            }

            const combinedHtml = limitedHtml.join("\n\n");
            let plainText = htmlToText(combinedHtml, {
              wordwrap: false,
              selectors: [
                { selector: "a", options: { ignoreHref: true } },
                { selector: "img", format: "skip" },
                { selector: "script", format: "skip" },
                { selector: "style", format: "skip" },
              ],
            });

            // If content is thin (JS-gated pages), consider using pasted job text from chat history
            let isThinContent = plainText.trim().length < 500;
            let historyLongUserText = null;
            if (isThinContent && Array.isArray(history)) {
              for (let i = history.length - 1; i >= 0; i--) {
                const m = history[i];
                if (
                  m &&
                  m.role === "user" &&
                  typeof m.content === "string" &&
                  m.content.trim().length > 600
                ) {
                  historyLongUserText = m.content.trim();
                  break;
                }
              }
              if (historyLongUserText) {
                plainText = historyLongUserText.slice(0, 120_000);
                isThinContent = false;
              }
            }
            const first = results[0] || {};
            const inferredTitle = (first.title || "").toString().trim();
            let inferredCompany = "";
            if (inferredTitle.includes(" - ")) {
              inferredCompany = inferredTitle.split(" - ")[0].trim();
            }
            let inferredDomain = "";
            try {
              inferredDomain = new URL(first.url || "").hostname;
            } catch {}

            // Derive intent: extraction if the user mentions JSON/CSV/fields; else summarization/Q&A
            const wantsJson = /\b(json|csv|extract|fields?)\b/i.test(
              fullMessage
            );
            const userAsk = message;

            if (!wantsFitAssessment && wantsJson) {
              const extractionPrompt = [
                "You are a precise data extraction engine.",
                "From the provided page content, extract the fields the user asked for.",
                "Output ONLY a valid JSON array. No prose, no backticks, no comments.",
                "If a field is missing, omit it rather than inventing values.",
                "Candidate Profile:",
                profileForAllChats.slice(0, 8000),
                "Page content:",
                plainText.slice(0, 90_000),
                "\nUser request:",
                userAsk.slice(0, 1000),
              ].join("\n\n");

              let jsonText = (
                await generateWithConfig(extractionPrompt, 1200, 0.4)
              ).trim();
              // Attempt to sanitize accidental fencing
              jsonText = jsonText
                .replace(/^```(json)?/i, "")
                .replace(/```$/i, "")
                .trim();

              const responseTime = (Date.now() - startTime) / 1000;
              aiChatResponseTime.observe(responseTime);
              aiChatRequestsTotal.inc({ status: "success" });
              res.setHeader("Cache-Control", "no-store");
              return res.json({
                response: jsonText,
                jobId: final?.id || null,
                timestamp: Date.now(),
              });
            } else if (!wantsFitAssessment) {
              if (isThinContent) {
                const lines = [];
                if (inferredTitle) lines.push(`Job Title: ${inferredTitle}`);
                if (inferredCompany) lines.push(`Company: ${inferredCompany}`);
                if (inferredDomain) lines.push(`Source: ${inferredDomain}`);
                lines.push(
                  "Summary: Limited public content; details may require login. Based on the title and source, this appears to be a software role. Paste the full description to get a deeper summary."
                );
                const responseTime = (Date.now() - startTime) / 1000;
                aiChatResponseTime.observe(responseTime);
                aiChatRequestsTotal.inc({ status: "success" });
                res.setHeader("Cache-Control", "no-store");
                return res.json({
                  response: lines.join("\n"),
                  jobId: final?.id || null,
                  timestamp: Date.now(),
                });
              }
              const summaryPrompt = [
                "You are an assistant that extracts structured details from a job posting. Use ONLY the provided page content.",
                "Write in third person. Do NOT use first-person (no 'I', 'my').",
                "Do NOT output shell commands or code blocks. Respond as plain text only.",
                "Produce a concise, high-signal summary with these sections (omit a section if unavailable):",
                "- Job Title",
                "- Company/Site",
                "- Location / Work Model (onsite/hybrid/remote) and any onsite frequency",
                "- Seniority Level",
                "- Required Years of Experience (quote exact text if present)",
                "- Core Tech/Stack (languages, frameworks, notable platforms)",
                "- Domain/Industry",
                "- Responsibilities (5–7 bullets)",
                "- Hard Requirements (quote exact text)",
                "- Nice-to-Haves (quote brief text)",
                "- Benefits/Compensation (if present)",
                "- Culture/Signals (tone, values)",
                "- Application Constraints (e.g., US-only, visa, hybrid days)",
                "- TL;DR (one or two lines)",
                "Candidate Profile (for context only; do NOT infer beyond page content):",
                profileForAllChats.slice(0, 8000),
                "\nJob Page Content:",
                plainText.slice(0, 90_000),
                "\nUser request:",
                userAsk.slice(0, 1000),
              ].join("\n\n");

              const text2 = await generateWithConfig(summaryPrompt, 1200, 0.6);

              const responseTime = (Date.now() - startTime) / 1000;
              aiChatResponseTime.observe(responseTime);
              aiChatRequestsTotal.inc({ status: "success" });
              res.setHeader("Cache-Control", "no-store");
              return res.json({
                response: text2,
                jobId: final?.id || null,
                timestamp: Date.now(),
              });
            } else {
              if (isThinContent) {
                const lines = [];
                if (inferredTitle) lines.push(`Job Title: ${inferredTitle}`);
                if (inferredCompany) lines.push(`Company: ${inferredCompany}`);
                if (inferredDomain) lines.push(`Source: ${inferredDomain}`);
                lines.push(
                  "Note: Limited public content; details may require login. Paste the full description for a deeper assessment."
                );
                const profile = getProfileContext();
                lines.push(
                  "\nPreliminary Fit (based on profile only): Good potential alignment; confirm years of experience and database specifics."
                );
                const responseTime = (Date.now() - startTime) / 1000;
                aiChatResponseTime.observe(responseTime);
                aiChatRequestsTotal.inc({ status: "success" });
                res.setHeader("Cache-Control", "no-store");
                return res.json({
                  response: lines.join("\n"),
                  jobId: final?.id || null,
                  timestamp: Date.now(),
                });
              }
              // Fit assessment using candidate profile + job content
              const profile = getProfileContext();
              const fitPrompt = [
                "You are a recruiter assistant. Evaluate candidate fit using ONLY the provided candidate profile and job content.",
                "Write in third person about the candidate (Kareem). Do NOT use first-person ('I', 'my').",
                "Do NOT output shell commands or code blocks. Respond as plain text only.",
                "First, extract HARD REQUIREMENTS (location/onsite rules, minimum years of experience, specific languages/frameworks/platforms).",
                "Gating rule: If any hard requirement clearly fails (e.g., 10+ years required and candidate has fewer; Elixir required and candidate lacks it; onsite constraint not met), set Decision Label to 'Not a Fit' and include a 'Blockers' section.",
                "Return a concise, structured assessment with:",
                "- Job Title",
                "- Company/Site",
                "- Role Summary (1–2 lines)",
                "- Hard Requirements (quote exact text from job)",
                "- Hard Requirements Check (Pass/Fail/Unknown with evidence):",
                "  • Location/Eligibility",
                "  • Years of Experience",
                "  • Specific Language/Framework (e.g., Elixir/Phoenix/Erlang if mentioned)",
                "  • Platform Experience (OpenAI/Anthropic/etc if mentioned)",
                "  • Core Stack Alignment",
                "- Responsibilities Highlights (3–6 bullets)",
                "- Strengths (3–5 bullets with evidence from candidate profile)",
                "- Gaps (3–5 bullets with evidence and whether trainable)",
                "- Blockers (only if any hard requirement fails)",
                "- Fit Score (0–100) and Decision Label: [Strong Fit, Good Fit, Possible Fit, Not a Fit] (apply gating rule)",
                "- Verdict (short paragraph with rationale)",
                "- Questions (up to 3) to resolve Unknowns",
                "Candidate Profile:",
                profile.slice(0, 8000),
                "\nJob Content:",
                plainText.slice(0, 90_000),
                "\nUser request:",
                userAsk.slice(0, 1000),
              ].join("\n\n");

              const text2 = await generateWithConfig(fitPrompt, 1400, 0.6);

              const responseTime = (Date.now() - startTime) / 1000;
              aiChatResponseTime.observe(responseTime);
              aiChatRequestsTotal.inc({ status: "success" });
              res.setHeader("Cache-Control", "no-store");
              return res.json({
                response: text2,
                jobId: final?.id || null,
                timestamp: Date.now(),
              });
            }
          }

          // Fallback: return job accepted message
          const text = target
            ? `Started scraping ${target}. I will post results when ready. Job ID: ${jobId}`
            : `I can assess fit using the job description. Please share the job URL or paste the job details here.`;
          const responseTime = (Date.now() - startTime) / 1000;
          aiChatResponseTime.observe(responseTime);
          aiChatRequestsTotal.inc({ status: "success" });
          res.setHeader("Cache-Control", "no-store");
          return res.json({
            response: text,
            jobId: jobId,
            timestamp: Date.now(),
          });
        } catch (e) {
          console.error("Scrape orchestration error:", e.message);
          // Fall through to normal chat if orchestration fails
        }
      }
    }

    // Generate response (default) with profile context
    const result = await chat.sendMessage(fullMessageWithProfile);
    const response = await result.response;
    const text = response.text();

    const responseTime = (Date.now() - startTime) / 1000;
    aiChatResponseTime.observe(responseTime);
    aiChatRequestsTotal.inc({ status: "success" });

    res.setHeader("Cache-Control", "no-store");
    res.json({
      response: text,
      timestamp: Date.now(),
    });
  } catch (error) {
    const responseTime = (Date.now() - startTime) / 1000;
    aiChatResponseTime.observe(responseTime);
    aiChatRequestsTotal.inc({ status: "error" });

    console.error("AI chat error:", error);

    // Provide a helpful error message
    let errorMessage =
      "Sorry, I encountered an error while processing your request.";

    if (error.message?.includes("API_KEY_INVALID")) {
      errorMessage =
        "AI service authentication failed. Please check GEMINI_API_KEY configuration.";
    } else if (error.message?.includes("QUOTA_EXCEEDED")) {
      errorMessage = "AI service quota exceeded. Please try again later.";
    } else if (error.message?.includes("RATE_LIMIT")) {
      errorMessage = "AI service rate limit exceeded. Please try again later.";
    }

    res.status(500).json({
      error: errorMessage,
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

// Start server
app.listen(PORT, () => {
  console.log(`AI Backend server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Metrics endpoint: http://localhost:${PORT}/metrics`);
  console.log(`Chat endpoint: http://localhost:${PORT}/chat`);

  if (!process.env.GEMINI_API_KEY) {
    console.warn(
      "⚠️  No GEMINI_API_KEY configured. Please set the environment variable."
    );
  } else {
    console.log("✅ Gemini API configured successfully");
  }
});
