import { serve } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ============ 类型定义 ============
interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface Config {
  llm: LLMConfig;
  llmBackup: LLMConfig; // 备用 LLM
  llmSettings: {
    timeout: number;      // 请求超时（毫秒）
    maxRetries: number;   // 最大重试次数
    useBackupOnFail: boolean; // 主 LLM 失败时是否使用备用
  };
  rss: { hours: number; topN: number; language: string };
  telegram: { enabled: boolean; botToken: string; chatId: string; pushCount: number };
  schedule: { enabled: boolean; cron: string };
  admin: { username: string; password: string };
}

interface Article {
  id: string;
  title: string;
  titleZh: string;
  link: string;
  content: string;
  summary: string;
  category: string;
  score: number;
  keywords: string[];
  reason: string;
  summaryMsgId: number | null;
  fullTextMsgId: number | null;
  translatedContent: string | null;
  createdAt: number;
}

interface RSSItem {
  title: string;
  link: string;
  content: string;
  pubDate: Date;
  source: string;
}

// ============ 数据目录 ============
const DATA_DIR = join(import.meta.dir, "data");
const CONFIG_FILE = join(DATA_DIR, "config.json");
const SEEN_FILE = join(DATA_DIR, "seen.json");
const ARTICLES_FILE = join(DATA_DIR, "articles.json");
const HISTORY_FILE = join(DATA_DIR, "history.json");
const LOG_FILE = join(DATA_DIR, "logs.json");

// 确保数据目录存在
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ============ 日志系统 ============
const MAX_LOGS = 500; // 最大日志条数
interface LogEntry {
  time: number;
  level: "info" | "warn" | "error";
  message: string;
}

let logsCache: LogEntry[] = [];

function initLogs() {
  try {
    if (existsSync(LOG_FILE)) {
      logsCache = JSON.parse(readFileSync(LOG_FILE, "utf-8"));
    }
  } catch (e) {
    logsCache = [];
  }
}

function addLog(level: LogEntry["level"], message: string) {
  const entry: LogEntry = { time: Date.now(), level, message };
  logsCache.push(entry);
  
  // 限制日志数量
  if (logsCache.length > MAX_LOGS) {
    logsCache = logsCache.slice(-MAX_LOGS);
  }
  
  // 异步保存（不阻塞）
  try {
    writeFileSync(LOG_FILE, JSON.stringify(logsCache));
  } catch (e) {}
}

function log(message: string) {
  console.log(message);
  addLog("info", message);
}

function logWarn(message: string) {
  console.warn(message);
  addLog("warn", message);
}

function logError(message: string) {
  console.error(message);
  addLog("error", message);
}

// 初始化日志
initLogs();

// ============ 默认配置 ============
const DEFAULT_CONFIG: Config = {
  llm: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o" },
  llmBackup: { baseUrl: "", apiKey: "", model: "" }, // 备用 LLM（可选）
llmSettings: {
    timeout: 120000,       // 120秒超时
    maxRetries: 2,         // 最多重试2次
    useBackupOnFail: true, // 主 LLM 失败时使用备用
  },
  rss: { hours: 48, topN: 15, language: "zh" },
  telegram: { enabled: false, botToken: "", chatId: "", pushCount: 10 },
  schedule: { enabled: false, cron: "0 8 * * *" },
  admin: { username: "admin", password: "admin123" },
};

// ============ JWT 认证 ============
const JWT_SECRET = process.env.JWT_SECRET || "ai-daily-secret-" + Math.random().toString(36).slice(2);
const TOKEN_EXPIRY = 24 * 60 * 60 * 1000; // 24小时

interface TokenPayload {
  username: string;
  exp: number;
}

function base64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64UrlDecode(str: string): string {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

function generateToken(username: string): string {
  const header = { alg: "HS256", typ: "JWT" };
  const payload: TokenPayload = { username, exp: Date.now() + TOKEN_EXPIRY };
  
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  
  // 简化签名（生产环境应使用 crypto.subtle）
  const signature = base64UrlEncode(
    Array.from(headerB64 + "." + payloadB64 + JWT_SECRET)
      .reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0)
      .toString(16)
  );
  
  return `${headerB64}.${payloadB64}.${signature}`;
}

function verifyToken(token: string): TokenPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const payload: TokenPayload = JSON.parse(base64UrlDecode(parts[1]));
    if (payload.exp < Date.now()) return null;
    
    // 验证签名
    const expectedSig = base64UrlEncode(
      Array.from(parts[0] + "." + parts[1] + JWT_SECRET)
        .reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0)
        .toString(16)
    );
    
    if (parts[2] !== expectedSig) return null;
    return payload;
  } catch {
    return null;
  }
}

function getTokenFromRequest(req: Request): string | null {
  // 从 Authorization header 获取
  const auth = req.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7);
  }
  // 从 Cookie 获取
  const cookie = req.headers.get("Cookie");
  if (cookie) {
    const match = cookie.match(/token=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

function isAuthenticated(req: Request): boolean {
  const token = getTokenFromRequest(req);
  if (!token) return false;
  return verifyToken(token) !== null;
}

// RSS 源配置
interface RSSFeed {
  url: string;
  source: string;
  enabled: boolean;
}

// 从外部文件加载默认 RSS 源
const DEFAULT_RSS_FILE = join(import.meta.dir, "rss-feeds.json");
const RSS_FILE = join(DATA_DIR, "rss.json");

function getDefaultRSSFeeds(): RSSFeed[] {
  if (existsSync(DEFAULT_RSS_FILE)) {
    try {
      return JSON.parse(readFileSync(DEFAULT_RSS_FILE, "utf-8"));
  } catch (e) {
    logError("读取默认 RSS 配置失败: " + (e as Error).message);
  }
  }
  // 最小回退列表
  return [
    { url: "https://lobste.rs/rss", source: "Lobste.rs", enabled: true },
    { url: "https://hnrss.org/newest?points=100", source: "HackerNews", enabled: true },
  ];
}

function getRSSFeeds(): RSSFeed[] {
  return loadJSON<RSSFeed[]>(RSS_FILE, getDefaultRSSFeeds());
}

// ============ 工具函数 ============
function loadJSON<T>(file: string, defaultValue: T): T {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf-8"));
  } catch {}
  return defaultValue;
}

function saveJSON(file: string, data: any) {
  writeFileSync(file, JSON.stringify(data, null, 2));
}

// 清理过期的 seen 记录（保留最近30天的URL）
function cleanupSeenData() {
  const seen = loadJSON<string[]>(SEEN_FILE, []);
  const MAX_SEEN = 5000; // 最多保留5000条
  
  if (seen.length > MAX_SEEN) {
    const trimmed = seen.slice(-MAX_SEEN); // 保留最新的
    saveJSON(SEEN_FILE, trimmed);
    log(`🧹 清理 seen.json: ${seen.length} → ${trimmed.length}`);
  }
}

// 清理过期文章（保留最近7天）
function cleanupArticles() {
  const articles = loadJSON<Record<string, Article>>(ARTICLES_FILE, {});
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  
  const cleaned: Record<string, Article> = {};
  let removed = 0;
  
  for (const [id, article] of Object.entries(articles)) {
    if (article.createdAt > cutoff) {
      cleaned[id] = article;
    } else {
      removed++;
    }
  }
  
  if (removed > 0) {
    saveJSON(ARTICLES_FILE, cleaned);
    log(`🧹 清理 articles.json: 移除 ${removed} 篇过期文章`);
  }
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/"/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// ============ RSS 解析 ============
async function fetchRSS(feedUrl: string, source: string): Promise<RSSItem[]> {
  try {
    const res = await fetch(feedUrl, {
      headers: { "User-Agent": "AI-Daily-Digest/1.0" },
    });
    const xml = await res.text();
    const items: RSSItem[] = [];

    // 简单 XML 解析
    const itemMatches = xml.match(/<item[\s\S]*?<\/item>/gi) || 
                        xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];

    for (const item of itemMatches) {
      const title = item.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i)?.[1] || "";
      const link = item.match(/<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i)?.[1] ||
                   item.match(/<link[^>]*href="([^"]+)"/i)?.[1] || "";
      const content = item.match(/<content[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content/i)?.[1] ||
                      item.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i)?.[1] || "";
      const pubDate = item.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)?.[1] ||
                      item.match(/<published[^>]*>([\s\S]*?)<\/published>/i)?.[1] ||
                      item.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i)?.[1] || "";

      if (title && link) {
        items.push({
          title: htmlToText(title),
          link: link.trim(),
          content: htmlToText(content).slice(0, 5000),
          pubDate: new Date(pubDate),
          source,
        });
      }
    }
    return items;
  } catch (e) {
    logError(`RSS fetch error [${source}]: ${(e as Error).message}`);
    return [];
  }
}

async function fetchAllFeeds(hours: number): Promise<RSSItem[]> {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const feeds = getRSSFeeds().filter(f => f.enabled);
  const results = await Promise.all(
    feeds.map((f) => fetchRSS(f.url, f.source))
  );
  return results
    .flat()
    .filter((item) => item.pubDate.getTime() > cutoff)
    .sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
}

// ============ AI 调用 ============
// 单次 LLM 请求（带超时）
async function callLLMOnce(llmConfig: LLMConfig, prompt: string, timeout: number): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const res = await fetch(`${llmConfig.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llmConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: llmConfig.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
      }),
      signal: controller.signal,
    });
    
    if (!res.ok) {
      throw new Error(`API 返回 ${res.status}: ${res.statusText}`);
    }
    
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("API 返回空内容");
    }
    return content;
  } finally {
    clearTimeout(timeoutId);
  }
}

// 带重试和备用切换的 LLM 调用
async function callLLM(config: Config, prompt: string): Promise<string> {
  const settings = config.llmSettings || DEFAULT_CONFIG.llmSettings;
  const timeout = settings.timeout || 60000;
  const maxRetries = settings.maxRetries || 2;
  
  // 尝试主 LLM
  if (config.llm.apiKey) {
    for (let i = 0; i <= maxRetries; i++) {
      try {
        log(`🤖 调用主 LLM (尝试 ${i + 1}/${maxRetries + 1})...`);
        return await callLLMOnce(config.llm, prompt, timeout);
      } catch (e: any) {
        logError(`主 LLM 失败 (${i + 1}/${maxRetries + 1}): ${e.message}`);
        if (i < maxRetries) {
          await new Promise(r => setTimeout(r, 1000 * (i + 1))); // 递增延迟
        }
      }
    }
  }
  
  // 主 LLM 失败，尝试备用 LLM
  if (settings.useBackupOnFail && config.llmBackup?.apiKey) {
    log("🔄 切换到备用 LLM...");
    for (let i = 0; i <= maxRetries; i++) {
      try {
        log(`🤖 调用备用 LLM (尝试 ${i + 1}/${maxRetries + 1})...`);
        return await callLLMOnce(config.llmBackup, prompt, timeout);
      } catch (e: any) {
        logError(`备用 LLM 失败 (${i + 1}/${maxRetries + 1}): ${e.message}`);
        if (i < maxRetries) {
          await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
      }
    }
  }
  
  throw new Error("所有 LLM 调用均失败");
}

async function scoreAndSummarize(
  config: Config,
  item: RSSItem
): Promise<{
  score: number;
  category: string;
  titleZh: string;
  summary: string;
  keywords: string[];
  reason: string;
} | null> {
  const prompt = `分析以下技术文章，返回 JSON 格式：

标题: ${item.title}
来源: ${item.source}
内容: ${item.content.slice(0, 3000)}

返回格式（只返回JSON，不要其他内容）：
{
  "score": 评分1-10,
  "category": "分类(engineering/ai/tools/other)",
  "titleZh": "中文标题",
  "summary": "4-6句中文摘要",
  "keywords": ["关键词1", "关键词2", "关键词3"],
  "reason": "一句话推荐理由"
}`;

  try {
    const result = await callLLM(config, prompt);
    const json = result.match(/\{[\s\S]*\}/)?.[0];
    if (json) return JSON.parse(json);
  } catch (e) {
    logError("AI scoring error: " + (e as Error).message);
  }
  return null;
}

async function translateFullText(config: Config, content: string): Promise<string> {
  const prompt = `将以下英文技术文章翻译成流畅的中文，保持技术术语准确：

${content.slice(0, 15000)}

直接返回翻译结果，不要添加额外说明。`;

  // 翻译全文需要更长的超时时间，使用配置超时的 2 倍（最少 120 秒）
  const settings = config.llmSettings || DEFAULT_CONFIG.llmSettings;
  const baseTimeout = settings.timeout || 60000;
  const translateTimeout = Math.max(baseTimeout * 2, 120000);
  
  // 创建一个临时的 config，使用更长的超时
  const translateConfig: Config = {
    ...config,
    llmSettings: {
      ...settings,
      timeout: translateTimeout,
    },
  };
  
  log(`⏱️ 翻译超时设置: ${translateTimeout / 1000}秒`);
  return await callLLM(translateConfig, prompt);
}

// ============ Telegram ============
async function sendTelegram(
  config: Config,
  text: string,
  replyMarkup?: any
): Promise<number | null> {
  if (!config.telegram.enabled || !config.telegram.botToken) return null;

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: config.telegram.chatId,
          text,
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        }),
      }
    );
    const data = await res.json();
    return data.result?.message_id || null;
  } catch (e) {
    logError("Telegram error: " + (e as Error).message);
    return null;
  }
}

async function editTelegramMessage(
  config: Config,
  messageId: number,
  text: string,
  replyMarkup?: any
): Promise<boolean> {
  if (!config.telegram.enabled || !config.telegram.botToken) return false;

  try {
    await fetch(
      `https://api.telegram.org/bot${config.telegram.botToken}/editMessageText`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: config.telegram.chatId,
          message_id: messageId,
          text,
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        }),
      }
    );
    return true;
  } catch (e) {
    logError("Telegram edit error: " + (e as Error).message);
    return false;
  }
}

function formatSummaryMessage(article: Article): { text: string; markup: any } {
  const categoryEmoji: Record<string, string> = {
    engineering: "⚙️ 工程",
    ai: "🤖 AI",
    tools: "🛠️ 工具",
    other: "📰 资讯",
  };

  // 评分星级显示
  const scoreStars = "★".repeat(Math.round(article.score / 2)) + "☆".repeat(5 - Math.round(article.score / 2));
  
  // 消息格式 - 标题完整显示不截断
  const text = `┏━━━━━━━━━━━━━━━━━━━━┓
┃ ${categoryEmoji[article.category] || "📰 资讯"}  ${scoreStars} <b>${article.score}</b>/10
┗━━━━━━━━━━━━━━━━━━━━┛

<b>📌 ${article.titleZh}</b>
<i>${article.title}</i>

━━━ 📝 摘要 ━━━
${article.summary}

━━━ 💡 推荐理由 ━━━
${article.reason}

🏷️ <code>${article.keywords.join(" · ")}</code>`;

  const markup = {
    inline_keyboard: [
      [
        { text: "📖 阅读中文全文", callback_data: `read_${article.id}` },
      ],
      [
        { text: "🔗 原文链接", url: article.link },
      ],
    ],
  };

  return { text, markup };
}

// 分段发送长消息的辅助函数
function splitLongText(text: string, maxLen: number = 4000): string[] {
  if (text.length <= maxLen) return [text];
  
  const parts: string[] = [];
  let remaining = text;
  
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }
    
    // 尝试在段落处分割
    let splitPos = remaining.lastIndexOf('\n\n', maxLen);
    if (splitPos < maxLen / 2) {
      // 如果段落分割点太靠前，尝试在句号处分割
      splitPos = remaining.lastIndexOf('。', maxLen);
    }
    if (splitPos < maxLen / 2) {
      // 如果还是太靠前，尝试在空格处分割
      splitPos = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitPos < maxLen / 2) {
      // 最后手段：强制在 maxLen 处分割
      splitPos = maxLen;
    }
    
    parts.push(remaining.slice(0, splitPos));
    remaining = remaining.slice(splitPos).trim();
  }
  
  return parts;
}

// 格式化全文消息 - 返回多条消息（支持长文分段）
function formatFullTextMessages(
  article: Article
): { texts: string[]; markup: any } {
  const content = article.translatedContent || "翻译中...";
  
  // 格式化内容 - 添加段落间距
  const formattedContent = content
    .split('\n\n')
    .map(p => p.trim())
    .filter(p => p)
    .join('\n\n');

  // 头部消息
  const header = `┏━━━━━━━━━━━━━━━━━━━━┓
┃ 📖 <b>全文翻译</b>
┗━━━━━━━━━━━━━━━━━━━━┛

<b>${article.titleZh}</b>

━━━━━━━━━━━━━━━━━━━━`;

  // 尾部
  const footer = `━━━━━━━━━━━━━━━━━━━━
🏷️ <code>${article.keywords?.join(" · ") || ""}</code>`;

  // 检查是否需要分段
  const fullText = `${header}\n\n${formattedContent}\n\n${footer}`;
  
  if (fullText.length <= 4000) {
    // 不需要分段
    return { texts: [fullText], markup: null };
  }
  
  // 需要分段发送
  const contentParts = splitLongText(formattedContent, 3800);
  const texts: string[] = [];
  
  // 第一条：标题 + 第一部分内容
  texts.push(`${header}\n\n${contentParts[0]}${contentParts.length > 1 ? '\n\n<i>📄 第 1/${contentParts.length} 部分</i>' : ''}`);
  
  // 中间部分
  for (let i = 1; i < contentParts.length - 1; i++) {
    texts.push(`${contentParts[i]}\n\n<i>📄 第 ${i + 1}/${contentParts.length} 部分</i>`);
  }
  
  // 最后一条：最后部分 + 尾部
  if (contentParts.length > 1) {
    texts.push(`${contentParts[contentParts.length - 1]}\n\n${footer}`);
  }

  // 按钮只在最后一条消息显示
  const inlineKeyboard: any[][] = [];
  
  // 如果有摘要消息 ID，添加返回按钮（使用消息链接直接跳转）
  if (article.summaryMsgId) {
    // 使用 callback 让后端返回跳转链接
    inlineKeyboard.push([
      { text: "↩️ 返回摘要", callback_data: `back_${article.summaryMsgId}` }
    ]);
  }
  
  inlineKeyboard.push([{ text: "🔗 原文链接", url: article.link }]);
  
  const markup = { inline_keyboard: inlineKeyboard };

  return { texts, markup };
}

// 保持旧函数兼容性（用于单条消息场景）
function formatFullTextMessage(
  article: Article
): { text: string; markup: any } {
  const { texts, markup } = formatFullTextMessages(article);
  return { text: texts[0], markup };
}

// ============ 核心任务 ============
let isDigestRunning = false;

async function runDigest(): Promise<{ success: boolean; message: string; count: number }> {
  // 防止重复执行
  if (isDigestRunning) {
    return { success: false, message: "任务正在运行中，请稍后再试", count: 0 };
  }
  isDigestRunning = true;

  try {
    const config = loadJSON<Config>(CONFIG_FILE, DEFAULT_CONFIG);
    const seen = loadJSON<string[]>(SEEN_FILE, []);
    const articles = loadJSON<Record<string, Article>>(ARTICLES_FILE, {});

    if (!config.llm.apiKey) {
      return { success: false, message: "请先配置 LLM API Key", count: 0 };
    }

  log("📡 抓取 RSS...");
  const items = await fetchAllFeeds(config.rss.hours);
  log(`获取到 ${items.length} 篇文章`);

  // 去重
  const newItems = items.filter((item) => !seen.includes(item.link));
  log(`去重后 ${newItems.length} 篇新文章`);

  if (newItems.length === 0) {
    return { success: true, message: "没有新文章", count: 0 };
  }

  // AI 评分
  const toProcess = newItems.slice(0, config.rss.topN * 2);
  log(`🤖 AI 评分中... (共 ${toProcess.length} 篇)`);
  const scored: { item: RSSItem; result: NonNullable<Awaited<ReturnType<typeof scoreAndSummarize>>> }[] = [];

  for (let i = 0; i < toProcess.length; i++) {
    const item = toProcess[i];
    log(`📝 [${i + 1}/${toProcess.length}] ${item.title.slice(0, 50)}...`);
    try {
      const result = await scoreAndSummarize(config, item);
      if (result && result.score >= 6) {
        scored.push({ item, result });
        log(`   ✅ 得分: ${result.score}`);
      } else if (result) {
        log(`   ⏭️ 得分: ${result.score} (跳过)`);
      } else {
        log(`   ❌ 评分失败`);
      }
    } catch (e: any) {
      logError(`   ❌ 错误: ${e.message}`);
    }
    // 避免 API 限流
    await new Promise((r) => setTimeout(r, 500));
  }

  // 排序取 TopN
  scored.sort((a, b) => b.result.score - a.result.score);
  const topArticles = scored.slice(0, config.telegram.pushCount);

  log(`筛选出 ${topArticles.length} 篇高质量文章`);

  // 推送
  const newArticles: Article[] = [];
  for (const { item, result } of topArticles) {
    const id = generateId();
    const article: Article = {
      id,
      title: item.title,
      titleZh: result.titleZh,
      link: item.link,
      content: item.content,
      summary: result.summary,
      category: result.category,
      score: result.score,
      keywords: result.keywords,
      reason: result.reason,
      summaryMsgId: null,
      fullTextMsgId: null,
      translatedContent: null,
      createdAt: Date.now(),
    };

    // 发送 Telegram
    const { text, markup } = formatSummaryMessage(article);
    const msgId = await sendTelegram(config, text, markup);
    article.summaryMsgId = msgId;

    // 保存
    articles[id] = article;
    seen.push(item.link);
    newArticles.push(article);

    await new Promise((r) => setTimeout(r, 300));
  }

  // 保存数据
  saveJSON(ARTICLES_FILE, articles);
  saveJSON(SEEN_FILE, seen);

  // 更新历史
  const history = loadJSON<any[]>(HISTORY_FILE, []);
  history.unshift({
    date: new Date().toISOString().split("T")[0],
    count: newArticles.length,
    articles: newArticles.map((a) => ({ id: a.id, title: a.titleZh, score: a.score })),
  });
  saveJSON(HISTORY_FILE, history.slice(0, 30)); // 保留30天

    return { success: true, message: `成功处理 ${newArticles.length} 篇文章`, count: newArticles.length };
  } catch (error: any) {
    logError("❌ 任务执行出错: " + error.message);
    return { success: false, message: `执行出错: ${error.message}`, count: 0 };
  } finally {
    isDigestRunning = false;
  }
}

// 发送多条Telegram消息（用于长文分段）
async function sendTelegramMessages(
  config: Config,
  texts: string[],
  finalMarkup?: any
): Promise<number | null> {
  let lastMsgId: number | null = null;
  
  for (let i = 0; i < texts.length; i++) {
    const isLast = i === texts.length - 1;
    const markup = isLast ? finalMarkup : undefined;
    
    lastMsgId = await sendTelegram(config, texts[i], markup);
    
    // 防止发送过快
    if (!isLast) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  
  return lastMsgId;
}

// ============ Telegram Webhook 处理 ============
async function handleTelegramCallback(callbackQuery: any): Promise<void> {
  const config = loadJSON<Config>(CONFIG_FILE, DEFAULT_CONFIG);
  const articles = loadJSON<Record<string, Article>>(ARTICLES_FILE, {});
  const data = callbackQuery.data as string;
  const chatId = callbackQuery.message?.chat?.id;

  if (data.startsWith("read_")) {
    const articleId = data.replace("read_", "");
    const article = articles[articleId];

    if (!article) {
      // 文章不存在，给出提示
      await fetch(
        `https://api.telegram.org/bot${config.telegram.botToken}/answerCallbackQuery`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            callback_query_id: callbackQuery.id,
            text: "❌ 文章不存在或已过期",
            show_alert: true,
          }),
        }
      );
      return;
    }

    // 应答回调（正在处理）
    await fetch(
      `https://api.telegram.org/bot${config.telegram.botToken}/answerCallbackQuery`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          callback_query_id: callbackQuery.id,
          text: "⏳ 正在加载...",
        }),
      }
    );

    // 如果还没翻译，先翻译
    if (!article.translatedContent) {
      // 发送"翻译中"提示
      const loadingMsg = `┏━━━━━━━━━━━━━━━━━━━━┓
┃ 📖 <b>全文翻译</b>
┗━━━━━━━━━━━━━━━━━━━━┛

<b>${article.titleZh}</b>

⏳ <i>正在翻译，请稍候...</i>`;
      const loadingMsgId = await sendTelegram(config, loadingMsg);

      // 翻译（带错误处理）
      try {
        log(`📖 开始翻译文章: ${article.titleZh}`);
        article.translatedContent = await translateFullText(config, article.content);
        log(`✅ 翻译完成: ${article.titleZh}`);
        saveJSON(ARTICLES_FILE, articles);
      } catch (e: any) {
        logError(`❌ 翻译失败: ${e.message}`);
        // 删除加载消息
        if (loadingMsgId) {
          await fetch(
            `https://api.telegram.org/bot${config.telegram.botToken}/deleteMessage`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: config.telegram.chatId,
                message_id: loadingMsgId,
              }),
            }
          );
        }
        // 发送错误提示
        await sendTelegram(config, `❌ <b>翻译失败</b>\n\n${article.titleZh}\n\n原因: ${e.message}\n\n请稍后重试或检查 LLM 配置。`);
        return;
      }

      // 删除加载消息
      if (loadingMsgId) {
        await fetch(
          `https://api.telegram.org/bot${config.telegram.botToken}/deleteMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: config.telegram.chatId,
              message_id: loadingMsgId,
            }),
          }
        );
      }
    }

    // 发送完整翻译（支持分段）
    const { texts, markup } = formatFullTextMessages(article);
    const lastMsgId = await sendTelegramMessages(config, texts, markup);
    article.fullTextMsgId = lastMsgId;
    saveJSON(ARTICLES_FILE, articles);
    
  } else if (data.startsWith("back_")) {
    const msgId = parseInt(data.replace("back_", ""));
    
    if (msgId && chatId) {
      // 尝试获取聊天信息来构建正确的链接
      let jumpUrl = "";
      let chatType = "";
      
      try {
        const chatInfoRes = await fetch(
          `https://api.telegram.org/bot${config.telegram.botToken}/getChat`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId }),
          }
        );
        const chatInfo = await chatInfoRes.json();
        
        if (chatInfo.ok) {
          const chat = chatInfo.result;
          chatType = chat.type;
          
          if (chat.username) {
            // 公开群组/频道：t.me/username/msgId
            jumpUrl = `https://t.me/${chat.username}/${msgId}`;
          } else if (chat.type === "supergroup" || chat.type === "channel") {
            // 私有超级群组/频道：t.me/c/chatId/msgId（chatId 需要去掉 -100 前缀）
            const shortChatId = String(chatId).replace(/^-100/, "");
            jumpUrl = `https://t.me/c/${shortChatId}/${msgId}`;
          }
          // 私聊 (chat.type === "private") 没有标准跳转链接
        }
        } catch (e) {
        logError("获取聊天信息失败: " + e);
      }
      
      if (jumpUrl) {
        // 使用 answerCallbackQuery 的 url 参数直接跳转
        await fetch(
          `https://api.telegram.org/bot${config.telegram.botToken}/answerCallbackQuery`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
              callback_query_id: callbackQuery.id,
              url: jumpUrl,
            }),
          }
        );
      } else if (chatType === "private") {
        // 私聊：发送一条临时消息引导用户
        await fetch(
          `https://api.telegram.org/bot${config.telegram.botToken}/answerCallbackQuery`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
              callback_query_id: callbackQuery.id,
              text: `📍 摘要在第 ${msgId} 条消息，请向上滑动查找`,
              show_alert: true,
            }),
          }
        );
      } else {
        // 普通群组或其他情况：回退到提示
        await fetch(
          `https://api.telegram.org/bot${config.telegram.botToken}/answerCallbackQuery`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
              callback_query_id: callbackQuery.id,
              text: "↩️ 请向上滑动查找摘要消息",
              show_alert: true,
            }),
          }
        );
      }
    } else {
      await fetch(
        `https://api.telegram.org/bot${config.telegram.botToken}/answerCallbackQuery`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ 
            callback_query_id: callbackQuery.id,
            text: "↩️ 请向上滑动查找摘要消息",
            show_alert: true,
          }),
        }
      );
    }
  } else {
    // 未知回调，应答避免 Telegram 显示"无效操作"
    await fetch(
      `https://api.telegram.org/bot${config.telegram.botToken}/answerCallbackQuery`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          callback_query_id: callbackQuery.id,
          text: "⚠️ 未知操作",
        }),
      }
    );
  }
}

// ============ 定时任务 ============
let scheduleTimer: Timer | null = null;

function setupSchedule(config: Config) {
  if (scheduleTimer) {
    clearInterval(scheduleTimer);
    scheduleTimer = null;
  }

  if (!config.schedule.enabled) return;

  // 简单实现：每分钟检查是否匹配 cron
  scheduleTimer = setInterval(() => {
    const now = new Date();
    const [minute, hour] = config.schedule.cron.split(" ");
    
    if (
      (minute === "*" || parseInt(minute) === now.getMinutes()) &&
      (hour === "*" || parseInt(hour) === now.getHours())
    ) {
      log("⏰ 定时任务触发");
      runDigest();
    }
  }, 60000);
}

// ============ 读取外部HTML文件 ============
function readHtmlFile(filename: string): string {
  const filepath = join(import.meta.dir, filename);
  if (existsSync(filepath)) {
    return readFileSync(filepath, "utf-8");
  }
  return `<h1>Error</h1><p>${filename} not found</p>`;
}

// 前端页面: admin.html 为外部文件, 登录页内嵌

// 登录页 HTML (内嵌)
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI Daily - 登录</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0f0f0f 0%, #1a1a2e 100%);
      color: #e0e0e0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-container {
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 12px;
      padding: 40px;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    }
    .login-header {
      text-align: center;
      margin-bottom: 30px;
    }
    .login-header h1 {
      font-size: 2rem;
      color: #4f9eff;
      margin-bottom: 8px;
    }
    .login-header p {
      color: #999;
      font-size: 0.9rem;
    }
    .form-group {
      margin-bottom: 20px;
    }
    .form-group label {
      display: block;
      margin-bottom: 8px;
      color: #999;
      font-size: 0.9rem;
    }
    .form-group input {
      width: 100%;
      padding: 12px 16px;
      background: #252525;
      border: 1px solid #333;
      border-radius: 8px;
      color: #e0e0e0;
      font-size: 1rem;
      transition: border-color 0.2s;
    }
    .form-group input:focus {
      outline: none;
      border-color: #4f9eff;
    }
    .btn {
      width: 100%;
      padding: 14px;
      background: #4f9eff;
      border: none;
      border-radius: 8px;
      color: #fff;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .btn:hover { background: #3a8aee; }
    .btn:disabled { background: #333; cursor: not-allowed; }
    .error-msg {
      background: rgba(244,67,54,0.1);
      border: 1px solid #f44336;
      color: #f44336;
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 20px;
      display: none;
      font-size: 0.9rem;
    }
    .error-msg.show { display: block; }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="login-header">
      <h1>📰 AI Daily</h1>
      <p>管理后台登录</p>
    </div>
    <div class="error-msg" id="error"></div>
    <form id="loginForm">
      <div class="form-group">
        <label>用户名</label>
        <input type="text" id="username" placeholder="请输入用户名" required>
      </div>
      <div class="form-group">
        <label>密码</label>
        <input type="password" id="password" placeholder="请输入密码" required>
      </div>
      <button type="submit" class="btn" id="submitBtn">登 录</button>
    </form>
  </div>
  <script>
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('submitBtn');
      const error = document.getElementById('error');
      
      btn.disabled = true;
      btn.textContent = '登录中...';
      error.classList.remove('show');
      
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: document.getElementById('username').value,
            password: document.getElementById('password').value,
          }),
        });
        const data = await res.json();
        
        if (data.success) {
          document.cookie = 'token=' + data.token + '; path=/; max-age=86400';
          window.location.href = '/admin';
        } else {
          error.textContent = data.message || '登录失败';
          error.classList.add('show');
        }
      } catch (err) {
        error.textContent = '网络错误，请重试';
        error.classList.add('show');
      }
      
      btn.disabled = false;
      btn.textContent = '登 录';
    });
  </script>
</body>
</html>`;

// ============ HTTP 服务器 ============
const config = loadJSON<Config>(CONFIG_FILE, DEFAULT_CONFIG);
setupSchedule(config);

// 启动时清理过期数据
cleanupSeenData();
cleanupArticles();

// 每天定时清理一次（使用日期标记避免重复/遗漏）
let lastCleanupDate = "";
setInterval(() => {
  const now = new Date();
  const today = now.toISOString().split("T")[0];
  // 凌晨3-4点之间，且今天还没清理过
  if (now.getHours() === 3 && lastCleanupDate !== today) {
    lastCleanupDate = today;
    log("🧹 执行每日数据清理...");
    cleanupSeenData();
    cleanupArticles();
  }
}, 60000);

serve({
  port: 25333,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    // 登录页面
    if (path === "/login") {
      return new Response(LOGIN_HTML, {
        headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // 登录 API
    if (path === "/api/login" && req.method === "POST") {
      try {
        const body = await req.json();
        const cfg = loadJSON<Config>(CONFIG_FILE, DEFAULT_CONFIG);
        
        if (body.username === cfg.admin.username && body.password === cfg.admin.password) {
          const token = generateToken(body.username);
          log(`👤 用户登录成功: ${body.username}`);
          return Response.json({ success: true, token }, { headers });
        } else {
          logWarn(`👤 登录失败 (用户名: ${body.username})`);
          return Response.json({ success: false, message: "用户名或密码错误" }, { headers });
        }
      } catch (e) {
        return Response.json({ success: false, message: "请求格式错误" }, { status: 400, headers });
      }
    }

    // 登出 API
    if (path === "/api/logout" && req.method === "POST") {
      return Response.json({ success: true }, {
        headers: {
          ...headers,
          "Set-Cookie": "token=; path=/; max-age=0",
        },
      });
    }

    // 检查认证状态 API
    if (path === "/api/auth/check") {
      const authenticated = isAuthenticated(req);
      return Response.json({ authenticated }, { headers });
    }

    // 根路径重定向到管理后台
    if (path === "/" || path === "/index.html") {
      return new Response(null, {
        status: 302,
        headers: { ...headers, "Location": "/admin" },
      });
    }

    // API: 状态
    if (path === "/api/status") {
      const cfg = loadJSON<Config>(CONFIG_FILE, DEFAULT_CONFIG);
      return Response.json({
        configured: !!cfg.llm.apiKey,
        telegramEnabled: cfg.telegram.enabled,
        scheduleEnabled: cfg.schedule.enabled,
      }, { headers });
    }

    // API: 配置（需要认证）
    if (path === "/api/config") {
      if (!isAuthenticated(req)) {
        return Response.json({ error: "未授权访问" }, { status: 401, headers });
      }
      if (req.method === "GET") {
        const cfg = loadJSON<Config>(CONFIG_FILE, DEFAULT_CONFIG);
        // 生成 API Key 提示（显示前4位和后4位）
        const maskKey = (key: string) => {
          if (!key || key.length < 12) return key ? "已配置" : "";
          return key.slice(0, 6) + "***" + key.slice(-4);
        };
        // 隐藏敏感信息，但提供提示
        return Response.json({
          ...cfg,
          llm: { ...cfg.llm, apiKey: "", apiKeyHint: maskKey(cfg.llm.apiKey) },
          llmBackup: cfg.llmBackup ? { ...cfg.llmBackup, apiKey: "", apiKeyHint: maskKey(cfg.llmBackup.apiKey) } : { baseUrl: "", apiKey: "", model: "", apiKeyHint: "" },
          llmSettings: cfg.llmSettings || DEFAULT_CONFIG.llmSettings,
          telegram: { ...cfg.telegram, botToken: cfg.telegram.botToken ? "***" : "" },
        }, { headers });
      }

      if (req.method === "POST") {
        const body = await req.json();
        const current = loadJSON<Config>(CONFIG_FILE, DEFAULT_CONFIG);
        
        // 合并配置，空字符串不覆盖已有值
        const newConfig: Config = {
          llm: {
            baseUrl: body.llm?.baseUrl || current.llm.baseUrl,
            apiKey: (body.llm?.apiKey === "***" || body.llm?.apiKey === "") ? current.llm.apiKey : (body.llm?.apiKey || current.llm.apiKey),
            model: body.llm?.model || current.llm.model,
          },
          llmBackup: {
            baseUrl: body.llmBackup?.baseUrl ?? current.llmBackup?.baseUrl ?? "",
            apiKey: (body.llmBackup?.apiKey === "***" || body.llmBackup?.apiKey === "") ? (current.llmBackup?.apiKey || "") : (body.llmBackup?.apiKey ?? current.llmBackup?.apiKey ?? ""),
            model: body.llmBackup?.model ?? current.llmBackup?.model ?? "",
          },
          llmSettings: {
            timeout: body.llmSettings?.timeout ?? current.llmSettings?.timeout ?? 60000,
            maxRetries: body.llmSettings?.maxRetries ?? current.llmSettings?.maxRetries ?? 2,
            useBackupOnFail: body.llmSettings?.useBackupOnFail ?? current.llmSettings?.useBackupOnFail ?? true,
          },
          rss: { ...current.rss, ...body.rss },
          telegram: {
            ...current.telegram,
            ...body.telegram,
            botToken: body.telegram?.botToken === "***" ? current.telegram.botToken : (body.telegram?.botToken || current.telegram.botToken),
          },
          schedule: { ...current.schedule, ...body.schedule },
          admin: current.admin, // 保留admin配置
        };

        saveJSON(CONFIG_FILE, newConfig);
        setupSchedule(newConfig);
        log("⚙️ 配置已更新");
        return Response.json({ success: true }, { headers });
      }
    }

    // API: 手动运行（需要认证）
    if (path === "/api/run" && req.method === "POST") {
      if (!isAuthenticated(req)) {
        return Response.json({ error: "未授权访问" }, { status: 401, headers });
      }
      log("▶️ 手动触发运行任务");
      const result = await runDigest();
      return Response.json(result, { headers });
    }

    // API: 历史
    if (path === "/api/history") {
      const history = loadJSON<any[]>(HISTORY_FILE, []);
      return Response.json(history, { headers });
    }

    // API: 日志（需要认证）
    if (path === "/api/logs") {
      if (!isAuthenticated(req)) {
        return Response.json({ error: "未授权访问" }, { status: 401, headers });
      }
      
      // 支持查询参数：limit（默认100），level（可选）
      const urlObj = new URL(req.url);
      const limit = Math.min(parseInt(urlObj.searchParams.get("limit") || "100"), MAX_LOGS);
      const level = urlObj.searchParams.get("level");
      
      let logs = logsCache;
      if (level) {
        logs = logs.filter(l => l.level === level);
      }
      
      // 返回最新的日志（倒序）
      return Response.json(logs.slice(-limit).reverse(), { headers });
    }

    // API: 清空日志（需要认证）
    if (path === "/api/logs/clear" && req.method === "POST") {
      if (!isAuthenticated(req)) {
        return Response.json({ error: "未授权访问" }, { status: 401, headers });
      }
      logsCache = [];
      writeFileSync(LOG_FILE, "[]");
      return Response.json({ success: true }, { headers });
    }

    // API: 文章详情
    if (path.startsWith("/api/article/")) {
      const id = path.replace("/api/article/", "");
      const articles = loadJSON<Record<string, Article>>(ARTICLES_FILE, {});
      const article = articles[id];
      if (article) {
        return Response.json(article, { headers });
      }
      return Response.json({ error: "Not found" }, { status: 404, headers });
    }

    // API: 翻译
    if (path.startsWith("/api/translate/") && req.method === "POST") {
      const id = path.replace("/api/translate/", "");
      const articles = loadJSON<Record<string, Article>>(ARTICLES_FILE, {});
      const article = articles[id];
      const cfg = loadJSON<Config>(CONFIG_FILE, DEFAULT_CONFIG);

      if (!article) {
        return Response.json({ error: "Not found" }, { status: 404, headers });
      }

      if (!article.translatedContent) {
        article.translatedContent = await translateFullText(cfg, article.content);
        saveJSON(ARTICLES_FILE, articles);
      }

      return Response.json({ content: article.translatedContent }, { headers });
    }

    // Telegram Webhook
    if (path === "/webhook/telegram" && req.method === "POST") {
      const body = await req.json();
      if (body.callback_query) {
        handleTelegramCallback(body.callback_query);
      }
      return Response.json({ ok: true }, { headers });
    }

    // API: 测试 Telegram 推送（需要认证）
    if (path === "/api/telegram/test" && req.method === "POST") {
      if (!isAuthenticated(req)) {
        return Response.json({ error: "未授权访问" }, { status: 401, headers });
      }
      
      const cfg = loadJSON<Config>(CONFIG_FILE, DEFAULT_CONFIG);
      
      if (!cfg.telegram.botToken || !cfg.telegram.chatId) {
        return Response.json({ 
          success: false, 
          message: "请先配置 Bot Token 和 Chat ID" 
        }, { headers });
      }
      
      // 发送测试消息
      const testMessage = `┏━━━━━━━━━━━━━━━━━━━━┓
┃ 🧪 <b>测试消息</b>
┗━━━━━━━━━━━━━━━━━━━━┛

<b>📌 AI Daily Digest 测试</b>
<i>This is a test message</i>

━━━ 📝 摘要 ━━━
这是一条测试消息，用于验证 Telegram 推送功能是否正常工作。

━━━ 💡 推荐理由 ━━━
配置验证测试

🏷️ <code>测试 · Telegram · AI Daily</code>

⏰ 发送时间: ${new Date().toLocaleString('zh-CN')}`;

      try {
        const res = await fetch(
          `https://api.telegram.org/bot${cfg.telegram.botToken}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: cfg.telegram.chatId,
              text: testMessage,
              parse_mode: "HTML",
            }),
          }
        );
        
        const data = await res.json();
        
        if (data.ok) {
          return Response.json({ success: true, message: "测试消息已发送" }, { headers });
        } else {
          return Response.json({ 
            success: false, 
            message: data.description || "发送失败" 
          }, { headers });
        }
      } catch (e: any) {
        return Response.json({ 
          success: false, 
          message: e.message || "网络错误" 
        }, { headers });
      }
    }

    // API: 设置 Telegram Webhook（需要认证）
    if (path === "/api/telegram/webhook" && req.method === "POST") {
      if (!isAuthenticated(req)) {
        return Response.json({ error: "未授权访问" }, { status: 401, headers });
      }

      try {
        const body = await req.json();
        const { webhookUrl } = body;
        const cfg = loadJSON<Config>(CONFIG_FILE, DEFAULT_CONFIG);

        if (!cfg.telegram.botToken) {
          return Response.json({ success: false, message: "请先配置 Bot Token" }, { headers });
        }

        // 如果提供了 URL，设置 webhook；否则删除 webhook
        const telegramUrl = webhookUrl
          ? `https://api.telegram.org/bot${cfg.telegram.botToken}/setWebhook`
          : `https://api.telegram.org/bot${cfg.telegram.botToken}/deleteWebhook`;
        
        const res = await fetch(telegramUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(webhookUrl ? { url: webhookUrl } : {}),
        });
        
        const data = await res.json();
        
        if (data.ok) {
          log(webhookUrl ? `🔗 Webhook 设置成功: ${webhookUrl}` : "🔗 Webhook 已删除");
          return Response.json({ 
            success: true, 
            message: webhookUrl ? "Webhook 设置成功" : "Webhook 已删除"
          }, { headers });
        } else {
          logError(`Webhook 设置失败: ${data.description || "未知错误"}`);
          return Response.json({ 
            success: false, 
            message: data.description || "设置失败" 
          }, { headers });
        }
      } catch (e: any) {
        logError(`Webhook 设置异常: ${e.message}`);
        return Response.json({ success: false, message: e.message }, { headers });
      }
    }

    // API: 获取 Telegram Webhook 状态（需要认证）
    if (path === "/api/telegram/webhook" && req.method === "GET") {
      if (!isAuthenticated(req)) {
        return Response.json({ error: "未授权访问" }, { status: 401, headers });
      }

      try {
        const cfg = loadJSON<Config>(CONFIG_FILE, DEFAULT_CONFIG);

        if (!cfg.telegram.botToken) {
          return Response.json({ success: false, message: "请先配置 Bot Token" }, { headers });
        }

        const res = await fetch(
          `https://api.telegram.org/bot${cfg.telegram.botToken}/getWebhookInfo`
        );
        const data = await res.json();
        
        if (data.ok) {
          return Response.json({ 
            success: true, 
            url: data.result.url || "",
            pendingUpdateCount: data.result.pending_update_count || 0,
            lastErrorMessage: data.result.last_error_message || "",
          }, { headers });
        } else {
          return Response.json({ success: false, message: "获取失败" }, { headers });
        }
      } catch (e: any) {
        return Response.json({ success: false, message: e.message }, { headers });
      }
    }

    // API: 获取 LLM 模型列表（需要认证）
    if (path === "/api/llm/models" && req.method === "POST") {
      if (!isAuthenticated(req)) {
        return Response.json({ error: "未授权访问" }, { status: 401, headers });
      }
      try {
        const body = await req.json().catch(() => ({}));
        let baseUrl = body.baseUrl;
        let apiKey = body.apiKey;
        const type = body.type; // 'primary' 或 'backup'
        
        // 如果请求体没有提供，从配置读取（根据 type 决定读取哪个配置）
        if (!baseUrl || !apiKey) {
          const cfg = loadJSON<Config>(CONFIG_FILE, DEFAULT_CONFIG);
          const isBackup = type === 'backup';
          const savedConfig = isBackup ? cfg.llmBackup : cfg.llm;
          baseUrl = baseUrl || savedConfig?.baseUrl;
          apiKey = apiKey || savedConfig?.apiKey;
        }
        
        if (!baseUrl || !apiKey) {
          return Response.json({ error: "请先配置 API Base URL 和 API Key" }, { status: 400, headers });
        }
        
        const res = await fetch(`${baseUrl}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) {
          return Response.json({ error: `API 请求失败: ${res.status}` }, { status: res.status, headers });
        }
        const data = await res.json();
        const models = (data.data || []).map((m: any) => m.id).sort();
        return Response.json({ models }, { headers });
      } catch (e: any) {
        return Response.json({ error: e.message || "获取模型列表失败" }, { status: 500, headers });
      }
    }

    // API: 单独测试 LLM 连接（需要认证）
    if (path === "/api/llm/test-single" && req.method === "POST") {
      if (!isAuthenticated(req)) {
        return Response.json({ error: "未授权访问" }, { status: 401, headers });
      }

      try {
        const body = await req.json();
        let { baseUrl, apiKey, model, type } = body;
        
        // 如果没有提供，从已保存的配置读取
        if (!baseUrl || !apiKey) {
          const cfg = loadJSON<Config>(CONFIG_FILE, DEFAULT_CONFIG);
          const isBackup = type === 'backup';
          const savedConfig = isBackup ? cfg.llmBackup : cfg.llm;
          baseUrl = baseUrl || savedConfig?.baseUrl;
          apiKey = apiKey || savedConfig?.apiKey;
          model = model || savedConfig?.model;
        }
        
        if (!baseUrl || !apiKey) {
          return Response.json({ error: "请先配置 API Base URL 和 API Key" }, { status: 400, headers });
        }

        const testPrompt = "Hi, please respond with 'OK' to confirm the connection is working.";
        const llmConfig: LLMConfig = { baseUrl, apiKey, model: model || "gpt-3.5-turbo" };
        
        const result = await callLLMOnce(llmConfig, testPrompt, 15000);
        return Response.json({ success: !!result }, { headers });
      } catch (e: any) {
        return Response.json({ success: false, error: e.message }, { headers });
      }
    }

    // API: 测试所有 LLM 连接（需要认证）
    if (path === "/api/llm/test" && req.method === "POST") {
      if (!isAuthenticated(req)) {
        return Response.json({ error: "未授权访问" }, { status: 401, headers });
      }

      const cfg = loadJSON<Config>(CONFIG_FILE, DEFAULT_CONFIG);
      const testPrompt = "Hi, please respond with 'OK' to confirm the connection is working.";
      
      let primarySuccess = false;
      let primaryError = "";
      let backupTested = false;
      let backupSuccess = false;
      let backupError = "";
      
      // 测试主 LLM
      if (cfg.llm.apiKey) {
        try {
          const result = await callLLMOnce(cfg.llm, testPrompt, 15000);
          primarySuccess = !!result;
        } catch (e: any) {
          primaryError = e.message;
        }
      } else {
        primaryError = "未配置主 LLM";
      }
      
      // 测试备用 LLM
      if (cfg.llmBackup?.apiKey) {
        backupTested = true;
        try {
          const result = await callLLMOnce(cfg.llmBackup, testPrompt, 15000);
          backupSuccess = !!result;
        } catch (e: any) {
          backupError = e.message;
        }
      }
      
      return Response.json({
        success: primarySuccess,
        message: primarySuccess ? "主 LLM 连接成功" : primaryError,
        backupTested,
        backupSuccess,
        backupError: backupError || undefined,
      }, { headers });
    }

    // API: RSS 源管理（需要认证）
    if (path === "/api/rss") {
      if (!isAuthenticated(req)) {
        return Response.json({ error: "未授权访问" }, { status: 401, headers });
      }
      if (req.method === "GET") {
        const feeds = getRSSFeeds();
        return Response.json(feeds, { headers });
      }
      if (req.method === "POST") {
        const body = await req.json();
        if (Array.isArray(body)) {
          saveJSON(RSS_FILE, body);
          log(`📡 RSS 源已更新 (共 ${body.length} 个)`);
          return Response.json({ success: true }, { headers });
        }
        return Response.json({ error: "Invalid format" }, { status: 400, headers });
      }
    }

    // API: 账号管理（需要认证）
    if (path === "/api/admin/account") {
      if (!isAuthenticated(req)) {
        return Response.json({ error: "未授权访问" }, { status: 401, headers });
      }
      
      const cfg = loadJSON<Config>(CONFIG_FILE, DEFAULT_CONFIG);
      
      if (req.method === "GET") {
        // 返回当前用户名（不返回密码）
        return Response.json({ username: cfg.admin?.username || "admin" }, { headers });
      }
      
      if (req.method === "POST") {
        try {
          const body = await req.json();
          const { username, currentPassword, newPassword } = body;
          
          // 验证当前密码
          if (currentPassword !== cfg.admin?.password) {
            return Response.json({ success: false, message: "当前密码错误" }, { headers });
          }
          
          // 验证新用户名
          if (!username || username.trim().length < 2) {
            return Response.json({ success: false, message: "用户名至少2个字符" }, { headers });
          }
          
          // 更新配置
          const updatedConfig = {
            ...cfg,
            admin: {
              username: username.trim(),
              password: newPassword || cfg.admin.password, // 如果没有新密码则保持原密码
            },
          };
          
          saveJSON(CONFIG_FILE, updatedConfig);
          log(`🔐 账号信息已更新: ${username.trim()}`);
          
          return Response.json({ success: true, message: "账号信息已更新" }, { headers });
        } catch (e: any) {
          logError(`账号更新失败: ${e.message}`);
          return Response.json({ success: false, message: e.message || "更新失败" }, { status: 400, headers });
        }
      }
    }

    // 管理后台页面（需要认证）
    if (path === "/admin") {
      if (!isAuthenticated(req)) {
        // 未登录，重定向到登录页
        return new Response(null, {
          status: 302,
          headers: { ...headers, "Location": "/login" },
        });
      }
      const html = readHtmlFile("admin.html");
      return new Response(html, {
        headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404, headers });
  },
});

log("🚀 AI Daily 运行在 http://localhost:25333");
