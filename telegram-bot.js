// ================= IMPORTS =================
const TelegramBot = require("node-telegram-bot-api");
const { spawn } = require("child_process");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ================= CONFIG =================
const BOT_TOKEN = "8970620272:AAE91-X9nNoJRS4mA_Qyd6OSF-Pa9a6EqwQ";
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const DATA_FILE = "data.json";

// ================= JSON STORAGE LOGIC =================
function loadData() {
    if (fs.existsSync(DATA_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
        } catch {
            return { pages: {}, channels: {} };
        }
    }
    return { pages: {}, channels: {} };
}

function saveData() {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ pages: userPages, channels: userM3u8 }, null, 4), "utf-8");
}

const db = loadData();
let userPages = db.pages || {};
let userM3u8 = db.channels || {};
const activePage = {};
const userStreams = {};

// ================= DASH FIX =================
function fixDashUrl(url) {
    if (!url) return null;
    return url.replace(/https:\/\/[^@]*?(video|scontent)[\w\-\.]*\.fbcdn\.net/g, "https://BeOut@$1.xx.fbcdn.net");
}

// ================= FACEBOOK API =================
async function getNewStream(chatId) {
    const chatIdStr = String(chatId);
    const pageName = activePage[chatId];

    if (!pageName || !userPages[chatIdStr] || !userPages[chatIdStr][pageName]) {
        return { streamUrl: null, liveId: null, dash: null, token: null };
    }

    const page = userPages[chatIdStr][pageName];

    try {
        const r = await axios.post(
            `https://graph.facebook.com/v17.0/${page.page_id}/live_videos`,
            null,
            {
                params: {
                    access_token: page.token,
                    status: "UNPUBLISHED",
                    title: "Forja TV Stream",
                    description: "Live Stream via Forja Bot",
                    enable_backup_ingest: "true",
                },
                timeout: 15000,
            }
        );

        const liveId = r.data.id;
        if (!liveId) return { streamUrl: null, liveId: null, dash: null, token: null };

        const info = await axios.get(`https://graph.facebook.com/v17.0/${liveId}`, {
            params: {
                access_token: page.token,
                fields: "stream_url,secure_stream_url,dash_preview_url",
            },
            timeout: 15000,
        });

        const streamUrl = info.data.secure_stream_url || info.data.stream_url;
        return { streamUrl, liveId, dash: fixDashUrl(info.data.dash_preview_url), token: page.token };
    } catch (e) {
        console.error("API Error:", e.message);
        return { streamUrl: null, liveId: null, dash: null, token: null };
    }
}

// ================= FFMPEG - PASSTHROUGH QUALITY =================
function startFfmpeg(streamUrl, source) {
    // جودة كيفما هيا من المصدر - بلا حدود ولا تغيير
    const command = [
        "-re",
        "-i", source,
        "-c:v", "copy",
        "-c:a", "copy",
        "-f", "flv",
        "-flvflags", "no_duration_filesize",
        streamUrl,
    ];
    return spawn("ffmpeg", command, { stdio: "ignore" });
}

// ================= FFMPEG WITH OVERLAY FILTER ONLY =================
function startFfmpegWithFilters(streamUrl, rtmpUrl, watermarkPath = null, overlayText = null) {
    const args = ["-re", "-i", streamUrl];
    const filters = [];

    if (watermarkPath) {
        args.push("-i", watermarkPath);
        filters.push("[1:v]scale=100:100[watermark];[0:v][watermark]overlay=10:10");
    }

    if (overlayText && overlayText.trim()) {
        const safeText = overlayText.replace(/['":]/g, "");
        const fontPath = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
        filters.push(`drawtext=text='${safeText}':fontcolor=white:fontsize=24:x=10:y=H-40:fontfile=${fontPath}`);
    }

    if (filters.length > 0) {
        args.push("-filter_complex", filters.join(";"));
        // هنا كمان manter qualité original
        args.push(
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "18",
            "-c:a", "aac",
            "-b:a", "192k",
            "-ar", "48000",
            "-f", "flv",
            "-flvflags", "no_duration_filesize",
            rtmpUrl
        );
    } else {
        args.push(
            "-c", "copy",
            "-f", "flv",
            "-flvflags", "no_duration_filesize",
            rtmpUrl
        );
    }

    return spawn("ffmpeg", args, { stdio: "ignore" });
}

// ================= STREAM THREAD =================
async function streamThread(chatId, source, name) {
    try {
        if (userStreams[chatId]?.[name]) {
            await stopStream(chatId, name);
        }

        const { streamUrl, liveId, dash, token } = await getNewStream(chatId);
        if (!streamUrl) {
            bot.sendMessage(chatId, `❌ فشل إنشاء بث لـ: ${name}\nتأكد من اختيار الصفحة الصحيحة بـ /usepage`);
            return;
        }

        const process = startFfmpeg(streamUrl, source);

        if (!userStreams[chatId]) userStreams[chatId] = {};
        userStreams[chatId][name] = { process, liveId, token, dashUrl: dash };

        let msg = `🚀 **بدأ البث بنجاح:**\n🎥 القناة: \`${name}\`\n📊 الجودة: كما هي من المصدر (بدون تعديل)`;
        if (dash) msg += `\n\n🔗 **رابط DASH للمعاينة:**\n\`${dash}\``;

        bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
    } catch (e) {
        console.error("Stream Error:", e.message);
    }
}

// ================= STOP STREAM =================
async function stopStream(chatId, name) {
    const info = userStreams[chatId]?.[name];
    if (!info) return;

    try {
        info.process.kill("SIGKILL");
        await axios.delete(`https://graph.facebook.com/v17.0/${info.liveId}`, {
            params: { access_token: info.token },
            timeout: 5000,
        });
    } catch {}

    delete userStreams[chatId][name];
    bot.sendMessage(chatId, `🛑 تم إيقاف: ${name}`);
}

// ================= COMMANDS =================
bot.onText(/\/testall/, async (msg) => {
    const streams = userStreams[msg.chat.id] || {};
    if (!Object.keys(streams).length) {
        bot.sendMessage(msg.chat.id, "❌ لا توجد قنوات تبث حالياً لفحصها.");
        return;
    }

    let statusMsg = "🧪 **فحص روابط DASH للبثوث النشطة:**\n\n";

    for (const [name, info] of Object.entries(streams)) {
        const dashUrl = info.dashUrl;
        if (!dashUrl) {
            statusMsg += `⚪️ **${name}**: لا يوجد رابط DASH لهذا البث.\n`;
            continue;
        }
        try {
            const check = await axios.get(dashUrl, { timeout: 10000 });
            statusMsg += check.status === 200
                ? `✅ **${name}**: رابط DASH يعمل بنجاح.\n`
                : `❌ **${name}**: رابط DASH لا يعمل (Error ${check.status}).\n`;
        } catch {
            statusMsg += `❌ **${name}**: رابط DASH متعطل (خطأ اتصال).\n`;
        }
    }

    bot.sendMessage(msg.chat.id, statusMsg, { parse_mode: "Markdown" });
});

bot.onText(/\/testm3u8/, async (msg) => {
    const chatIdStr = String(msg.chat.id);
    const savedChannels = userM3u8[chatIdStr] || {};

    if (!Object.keys(savedChannels).length) {
        bot.sendMessage(msg.chat.id, "❌ لا توجد قنوات محفوظة لفحصها. استخدم /savem3u8 أولاً.");
        return;
    }

    const waitMsg = await bot.sendMessage(msg.chat.id, "⏳ جاري فحص الروابط المحفوظة...");
    let report = "🧪 **تقرير فحص القنوات المحفوظة:**\n\n";

    for (const [name, url] of Object.entries(savedChannels)) {
        let linkType = "🔗 URL";
        if (url.toLowerCase().includes(".m3u8")) linkType = "🎥 M3U8";
        else if (url.toLowerCase().includes(".mpd")) linkType = "📦 MPD";

        try {
            let response = await axios.head(url, { timeout: 5000, maxRedirects: 5 });
            if (response.status >= 400) response = await axios.get(url, { timeout: 5000 });
            report += response.status === 200
                ? `✅ **${name}**\n┗ النوع: \`${linkType}\` | الحالة: \`شغال\`\n\n`
                : `❌ **${name}**\n┗ النوع: \`${linkType}\` | الحالة: \`خطأ ${response.status}\`\n\n`;
        } catch {
            report += `⚠️ **${name}**\n┗ النوع: \`${linkType}\` | الحالة: \`غير مستجيب\`\n\n`;
        }
    }

    bot.deleteMessage(msg.chat.id, waitMsg.message_id);

    if (report.length > 4000) {
        for (let i = 0; i < report.length; i += 4000) {
            bot.sendMessage(msg.chat.id, report.slice(i, i + 4000), { parse_mode: "Markdown" });
        }
    } else {
        bot.sendMessage(msg.chat.id, report, { parse_mode: "Markdown" });
    }
});

bot.onText(/\/check/, async (msg) => {
    const chatIdStr = String(msg.chat.id);
    if (!userPages[chatIdStr] || !Object.keys(userPages[chatIdStr]).length) {
        bot.sendMessage(msg.chat.id, "❌ ليس لديك صفحات مسجلة للتحقق منها.");
        return;
    }

    let statusMsg = "🔍 **نتائج التحقق من التوكنات:**\n\n";

    for (const [name, data] of Object.entries(userPages[chatIdStr])) {
        try {
            const response = await axios.get("https://graph.facebook.com/me", {
                params: { access_token: data.token },
                timeout: 10000,
            });
            statusMsg += response.status === 200
                ? `✅ **${name}**: هذا التوكن شغال\n`
                : `❌ **${name}**: هذا التوكن غير صالح\n`;
        } catch {
            statusMsg += `⚠️ **${name}**: تعذر التحقق (خطأ في الاتصال)\n`;
        }
    }

    bot.sendMessage(msg.chat.id, statusMsg, { parse_mode: "Markdown" });
});

bot.onText(/\/addpage (.+)/, (msg, match) => {
    try {
        const parts = match[1].trim().split(/\s+/);
        if (parts.length < 3) throw new Error();
        const [name, pageId, token] = parts;
        const chatIdStr = String(msg.chat.id);
        if (!userPages[chatIdStr]) userPages[chatIdStr] = {};
        userPages[chatIdStr][name] = { page_id: pageId, token };
        saveData();
        bot.sendMessage(msg.chat.id, `✅ تم إضافة الصفحة \`${name}\` بنجاح.`, { parse_mode: "Markdown" });
    } catch {
        bot.sendMessage(msg.chat.id, "⚠️ الصيغة: `/addpage الاسم ID التوكن`", { parse_mode: "Markdown" });
    }
});

bot.onText(/\/usepage (.+)/, (msg, match) => {
    const name = match[1].trim();
    const chatIdStr = String(msg.chat.id);
    if (userPages[chatIdStr]?.[name]) {
        activePage[msg.chat.id] = name;
        bot.sendMessage(msg.chat.id, `🎯 الصفحة النشطة الآن: \`${name}\``, { parse_mode: "Markdown" });
    } else {
        bot.sendMessage(msg.chat.id, `❌ الصفحة \`${name}\` غير موجودة.`);
    }
});

bot.onText(/\/savem3u8 (\S+) (\S+)/, (msg, match) => {
    const [, name, url] = match;
    const chatIdStr = String(msg.chat.id);
    if (!userM3u8[chatIdStr]) userM3u8[chatIdStr] = {};
    userM3u8[chatIdStr][name] = url;
    saveData();
    bot.sendMessage(msg.chat.id, `💾 تم حفظ القناة: \`${name}\``, { parse_mode: "Markdown" });
});

bot.onText(/\/m3u8list/, (msg) => {
    const chatIdStr = String(msg.chat.id);
    const data = userM3u8[chatIdStr];
    if (!data || !Object.keys(data).length) {
        bot.sendMessage(msg.chat.id, "❌ قائمة القنوات فارغة.");
        return;
    }
    let txt = "📺 **القنوات المحفوظة:**\n";
    for (const n of Object.keys(data)) txt += `- \`${n}\`\n`;
    bot.sendMessage(msg.chat.id, txt, { parse_mode: "Markdown" });
});

bot.onText(/\/stopall/, async (msg) => {
    const streams = userStreams[msg.chat.id] || {};
    if (!Object.keys(streams).length) {
        bot.sendMessage(msg.chat.id, "❌ لا توجد بثوث نشطة.");
        return;
    }
    for (const name of Object.keys(streams)) {
        await stopStream(msg.chat.id, name);
    }
    bot.sendMessage(msg.chat.id, "🛑 تم تنظيف الرام وإيقاف جميع العمليات.");
});

// ================= HANDLE TXT FILE =================
bot.on("document", async (msg) => {
    if (!msg.document.file_name.toLowerCase().endsWith(".txt")) return;
    try {
        const fileLink = await bot.getFileLink(msg.document.file_id);
        const response = await axios.get(fileLink, { responseType: "text" });
        const chatIdStr = String(msg.chat.id);
        if (!userM3u8[chatIdStr]) userM3u8[chatIdStr] = {};
        let count = 0;
        for (const line of response.data.split("\n")) {
            const trimmed = line.trim();
            if (trimmed && trimmed.includes(" ")) {
                const [name, ...rest] = trimmed.split(/\s+/);
                const url = rest.join(" ");
                if (url.startsWith("http")) {
                    userM3u8[chatIdStr][name] = url;
                    count++;
                }
            }
        }
        saveData();
        bot.sendMessage(msg.chat.id, `💾 تم استيراد ${count} قناة بنجاح.`);
    } catch (e) {
        bot.sendMessage(msg.chat.id, `❌ خطأ في الملف: ${e.message}`);
    }
});

// ================= START BY NAME =================
bot.on("message", async (msg) => {
    if (msg.text?.startsWith("/") || msg.document) return;

    if (!activePage[msg.chat.id]) {
        bot.sendMessage(msg.chat.id, "⚠️ اختر صفحة أولاً باستخدام `/usepage`", { parse_mode: "Markdown" });
        return;
    }

    const chatIdStr = String(msg.chat.id);
    const saved = userM3u8[chatIdStr] || {};
    const names = msg.text.split("\n");
    let startedCount = 0;

    for (const n of names) {
        const trimmed = n.trim();
        if (saved[trimmed]) {
            streamThread(msg.chat.id, saved[trimmed], trimmed);
            startedCount++;
        }
    }

    if (startedCount === 0) {
        bot.sendMessage(msg.chat.id, "❌ لم يتم العثور على اسم قناة مطابق.");
    }
});

console.log("🎬 Bot ZenGo is Running ...");
