/**
 * Telegram 双向机器人 Cloudflare Worker (网页大盘 + TG内建控制台版)
 * 1. 根目录直接访问 Web 管理面板 (高级 SaaS UI - 支持中英双语 & 暗黑模式)
 * 2. TG 内部自动生成「📋 用户资料卡汇总」话题，统一集中管理
 * 3. 【极致人性化排版】有用户名时直达主页，无用户名时再显示后备主页链接
 * 4. 【昵称醒目化】采用原生加粗，安全免疫花字 Bug
 * 5. 【强化】不死「汇总贴」机制，丢失立刻自动重建
 */

// ==================== D1 数据库操作 ====================
async function dbConfigGet(key, env) {
    const row = await env.TG_BOT_DB.prepare("SELECT value FROM config WHERE key = ?").bind(key).first();
    return row ? row.value : null;
}
async function dbConfigPut(key, value, env) {
    await env.TG_BOT_DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").bind(key, value).run();
}
async function dbUserGetOrCreate(userId, env) {
    let user = await env.TG_BOT_DB.prepare("SELECT * FROM users WHERE user_id = ?").bind(userId).first();
    if (!user) {
        await env.TG_BOT_DB.prepare("INSERT INTO users (user_id, user_state, is_blocked, block_count) VALUES (?, 'new', 0, 0)").bind(userId).run();
        user = await env.TG_BOT_DB.prepare("SELECT * FROM users WHERE user_id = ?").bind(userId).first();
    }
    if (user) {
        user.is_blocked = user.is_blocked === 1;
        user.user_info = user.user_info_json ? JSON.parse(user.user_info_json) : null;
    }
    return user;
}
async function dbUserUpdate(userId, data, env) {
    if (data.user_info) { data.user_info_json = JSON.stringify(data.user_info); delete data.user_info; }
    const fields = Object.keys(data).map(key => (key === 'is_blocked' && typeof data[key] === 'boolean') ? 'is_blocked = ?' : `${key} = ?`).join(', ');
    const values = Object.keys(data).map(key => (key === 'is_blocked' && typeof data[key] === 'boolean') ? (data[key] ? 1 : 0) : data[key]);
    await env.TG_BOT_DB.prepare(`UPDATE users SET ${fields} WHERE user_id = ?`).bind(...values, userId).run();
}
async function dbTopicUserGet(topicId, env) {
    const row = await env.TG_BOT_DB.prepare("SELECT user_id FROM users WHERE topic_id = ?").bind(topicId).first();
    return row ? row.user_id : null;
}
async function dbMessageDataPut(userId, messageId, data, env) {
    await env.TG_BOT_DB.prepare("INSERT OR REPLACE INTO messages (user_id, message_id, text, date) VALUES (?, ?, ?, ?)").bind(userId, messageId, data.text, data.date).run();
}
async function dbMessageDataGet(userId, messageId, env) {
    return await env.TG_BOT_DB.prepare("SELECT text, date FROM messages WHERE user_id = ? AND message_id = ?").bind(userId, messageId).first() || null;
}
async function dbAdminStateDelete(userId, env) {
    await env.TG_BOT_DB.prepare("DELETE FROM config WHERE key = ?").bind(`admin_state:${userId}`).run();
}
async function dbAdminStateGet(userId, env) {
    return await dbConfigGet(`admin_state:${userId}`, env) || null;
}
async function dbMigrate(env) {
    if (!env.TG_BOT_DB) throw new Error("缺少 D1 数据库绑定 'TG_BOT_DB'");
    await env.TG_BOT_DB.batch([
        env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);`),
        env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY NOT NULL, user_state TEXT NOT NULL DEFAULT 'new', is_blocked INTEGER NOT NULL DEFAULT 0, block_count INTEGER NOT NULL DEFAULT 0, topic_id TEXT, user_info_json TEXT);`),
        env.TG_BOT_DB.prepare(`CREATE TABLE IF NOT EXISTS messages (user_id TEXT NOT NULL, message_id TEXT NOT NULL, text TEXT, date INTEGER, PRIMARY KEY (user_id, message_id));`),
    ]);
}

// ==================== 辅助与卡片生成 ====================
function escapeHtml(text) {
    return text ? text.toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : '';
}

function getUserInfo(user, initialTimestamp = null) {
    const userId = user.id.toString();
    let rawName = (user.first_name || "") + (user.last_name ? ` ${user.last_name}` : "");
    if (!rawName.trim()) rawName = `未命名用户_${userId.substring(0,4)}`; 

    let baseTopicName = `${rawName.trim()} | ${userId}`;
    const topicName = Array.from(baseTopicName).slice(0, 128).join(''); 
    const timestamp = initialTimestamp ? new Date(initialTimestamp * 1000).toLocaleString('zh-CN') : new Date().toLocaleString('zh-CN');
    
    let usernameDisplay = "";
    let idDisplay = "";

    if (user.username) {
        usernameDisplay = `<a href="https://t.me/${user.username}">@${escapeHtml(user.username)}</a>`;
        idDisplay = `<code>${userId}</code>`;
    } else {
        usernameDisplay = "无";
        idDisplay = `<code>${userId}</code> <a href="tg://user?id=${userId}">[🔗 查主页]</a>`;
    }
    
    const infoCard = `<b>👤 用户资料卡</b>\n---\n• 昵称: <b>${escapeHtml(rawName)}</b>\n• 用户名: ${usernameDisplay}\n• ID: ${idDisplay}\n• 连接时间: <code>${timestamp}</code>`;

    return { 
        userId, 
        name: rawName, 
        username: user.username ? `@${user.username}` : "无", 
        topicName, 
        infoCard 
    };
}

async function getSummaryTopicId(env) {
    let topicId = await dbConfigGet('summary_topic_id', env);
    if (!topicId) {
        try {
            const newTopic = await telegramApi(env.BOT_TOKEN, "createForumTopic", {
                chat_id: env.ADMIN_GROUP_ID,
                name: "📋 用户资料卡汇总"
            });
            topicId = newTopic.message_thread_id.toString();
            await dbConfigPut('summary_topic_id', topicId, env);
        } catch (e) { console.error("创建汇总话题失败", e); }
    }
    return topicId;
}

function getEnhancedInfoCardButtons(userId, isBlocked, isMuted, topicId, env) {
    const adminGroupIdStr = env.ADMIN_GROUP_ID.toString();
    const chatUrl = adminGroupIdStr.startsWith('-100') 
        ? `https://t.me/c/${adminGroupIdStr.replace('-100', '')}/${topicId}`
        : `https://t.me/${adminGroupIdStr.replace('@', '')}/${topicId}`;

    return {
        inline_keyboard: [
            [
                { text: "📌 置顶卡片", callback_data: `pin_card:${userId}` },
                { text: "🗑️ 重置(删档)", callback_data: `reset_user:${userId}` }
            ],
            [
                { text: isBlocked ? "✅ 解除屏蔽" : "🚫 屏蔽消息", callback_data: `block_toggle:${userId}` },
                { text: isMuted ? "🔔 恢复提醒" : "🔕 静音通知", callback_data: `mute_toggle:${userId}` }
            ],
            [
                { text: "💬 点击进入专属会话窗口", url: chatUrl }
            ]
        ]
    };
}

async function getConfig(key, env, defaultValue) {
    const configValue = await dbConfigGet(key, env);
    if (configValue !== null) return configValue;
    return env[key.toUpperCase().replace('WELCOME_MSG', 'WELCOME_MESSAGE')] ?? defaultValue;
}

function isPrimaryAdmin(userId, env) {
    if (!env.ADMIN_IDS || !userId) return false;
    return env.ADMIN_IDS.split(',').map(id => id.trim()).includes(userId.toString());
}

async function getAuthorizedAdmins(env) {
    try { return JSON.parse(await getConfig('authorized_admins', env, '[]')).map(String); } catch { return []; }
}
async function isAdminUser(userId, env) {
    return isPrimaryAdmin(userId, env) || (await getAuthorizedAdmins(env)).includes(userId.toString());
}

async function telegramApi(token, methodName, params = {}) {
    const res = await fetch(`https://api.telegram.org/bot${token}/${methodName}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description);
    return data.result;
}

// ==================== 全新高级 UI 网页代码 (支持多语言 + 暗色模式) ====================
const ADMIN_HTML = `
<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>TGbot | Control Center</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config = { darkMode: 'class' }</script>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;900&display=swap');
body{font-family:'Inter',sans-serif;}
.fade-in{animation:fadeIn 0.5s ease-out;} @keyframes fadeIn{from{opacity:0;transform:translateY(15px);}to{opacity:1;transform:translateY(0);}}
.hide-scrollbar::-webkit-scrollbar{display:none;} .hide-scrollbar{-ms-overflow-style:none;scrollbar-width:none;}
.glass-effect{backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);}
</style></head>
<body class="flex items-center justify-center h-screen overflow-hidden text-gray-800 bg-[#d4d4d8] dark:bg-zinc-950 transition-colors duration-300">
    
    <!-- Login Screen -->
    <div id="login-box" class="w-full max-w-sm px-4 fade-in z-10">
        <div class="bg-white dark:bg-zinc-900 rounded-[2.5rem] p-10 shadow-[0_20px_50px_rgba(0,0,0,0.1)] dark:shadow-none border border-gray-100 dark:border-zinc-800 text-center relative overflow-hidden transition-colors duration-300">
            <div class="w-16 h-16 bg-gradient-to-br from-[#ff6b4a] to-[#ff4a2b] rounded-full flex items-center justify-center mx-auto mb-6 shadow-lg shadow-orange-500/30 text-white">
                <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"></path></svg>
            </div>
            <h2 class="text-3xl font-black text-gray-900 dark:text-white mb-2 tracking-tight" data-i18n="loginTitle">TGBOT</h2>
            <p class="text-gray-400 text-sm mb-8 font-medium" data-i18n="loginSub">Please enter your supervisor ID</p>
            <input type="password" id="admin-pwd" class="w-full px-5 py-4 bg-gray-50 dark:bg-zinc-950 rounded-2xl border border-transparent focus:border-orange-200 focus:ring-4 focus:ring-orange-100 dark:focus:ring-orange-900/30 outline-none mb-6 text-gray-700 dark:text-gray-200 placeholder-gray-400 font-medium transition-all text-center tracking-widest" data-i18n="pwdPlaceholder" placeholder="ID Number">
            <button onclick="login()" id="login-btn" class="w-full bg-gradient-to-r from-[#ff6b4a] to-[#ff4a2b] hover:from-[#e55938] hover:to-[#e53a1a] text-white font-bold py-4 rounded-2xl shadow-[0_10px_20px_rgba(255,107,74,0.3)] transition-transform hover:-translate-y-1 active:translate-y-0" data-i18n="loginBtn">Access Now</button>
        </div>
    </div>

    <!-- Main Dashboard -->
    <div id="dashboard-box" class="hidden w-full h-full p-2 md:p-6 fade-in flex gap-6 box-border max-w-[1600px] mx-auto">
        <!-- Sidebar -->
        <div class="w-[280px] bg-[#27272a] rounded-[2.5rem] flex-col p-6 shadow-2xl relative overflow-hidden hidden lg:flex shrink-0">
            <div class="text-white font-black text-3xl mb-12 flex items-center gap-3 mt-4 px-2 tracking-tighter">
                <div class="w-10 h-10 bg-gradient-to-br from-[#ff6b4a] to-[#ff4a2b] rounded-full flex items-center justify-center shadow-lg shadow-orange-500/40 shrink-0">
                    <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"></path></svg>
                </div>
                <div>TG<span class="text-[#ff6b4a]">bot.</span></div>
            </div>
            
            <nav class="flex flex-col gap-3 flex-1">
                <div onclick="switchTab('dashboard')" class="flex items-center gap-4 text-white bg-white/10 px-5 py-4 rounded-2xl cursor-pointer backdrop-blur-sm border border-white/5 transition-colors group" id="nav-dash-bg">
                    <div id="nav-dash-dot" class="w-2 h-2 rounded-full bg-[#ff6b4a] shadow-[0_0_8px_rgba(255,107,74,0.8)] transition-colors"></div>
                    <span id="nav-dash-text" class="font-bold text-sm tracking-wide text-white group-hover:text-white transition-colors" data-i18n="navDash">Dashboard</span>
                </div>
                <div onclick="switchTab('settings')" class="flex items-center gap-4 text-white bg-transparent px-5 py-4 rounded-2xl cursor-pointer backdrop-blur-sm border border-transparent hover:bg-white/5 transition-colors group" id="nav-set-bg">
                    <div id="nav-set-dot" class="w-2 h-2 rounded-full bg-gray-600 group-hover:bg-gray-400 transition-colors"></div>
                    <span id="nav-set-text" class="font-bold text-sm tracking-wide text-gray-400 group-hover:text-white transition-colors" data-i18n="navSet">Settings</span>
                </div>
            </nav>

            <div class="bg-[#3f3f46] rounded-3xl p-6 mt-auto relative overflow-hidden group">
                 <div class="absolute -right-4 -top-4 w-20 h-20 bg-white/5 rounded-full blur-xl group-hover:bg-[#ff6b4a]/20 transition-all"></div>
                 <h4 class="text-white font-bold text-sm mb-1 tracking-wide relative z-10" data-i18n="sysId">System Identity</h4>
                 <p class="text-xs text-gray-400 mb-5 relative z-10 font-medium" data-i18n="sysSub">Logged in securely.</p>
                 <button onclick="logout()" class="relative z-10 text-xs font-bold bg-white text-black px-5 py-2.5 rounded-full hover:bg-gray-200 transition-transform hover:scale-105 shadow-md" data-i18n="logout">Sign Out</button>
            </div>
        </div>

        <!-- Main Content Area -->
        <div class="flex-1 bg-[#f4f4f5] dark:bg-zinc-900 md:rounded-[2.5rem] rounded-2xl shadow-xl flex flex-col p-6 md:p-12 overflow-hidden relative border border-white dark:border-zinc-800 transition-colors duration-300">
            <div class="overflow-y-auto h-full pr-2 pb-10 hide-scrollbar">
                
                <!-- ================= DASHBOARD VIEW ================= -->
                <div id="view-dashboard" class="block fade-in">
                    <div class="flex flex-col md:flex-row justify-between items-start md:items-end mb-12 gap-6">
                        <div>
                            <h1 class="text-4xl md:text-6xl font-black text-gray-900 dark:text-white tracking-tighter leading-none mb-3" data-i18n="mainTitle">Let's start<br>managing!</h1>
                            <p class="text-gray-500 dark:text-gray-400 font-medium text-sm tracking-wide" data-i18n="mainSub">TG Bot Data & User Control Center</p>
                        </div>
                        <div class="glass-effect bg-white/50 dark:bg-zinc-800/50 rounded-[2rem] p-4 flex items-center gap-6 border border-white dark:border-zinc-700 shadow-sm self-start md:self-end transition-colors">
                             <div class="pl-2">
                                 <p class="text-[10px] text-gray-400 font-bold uppercase tracking-widest mb-1" data-i18n="statusAction">Status Action</p>
                                 <p class="text-sm font-black text-gray-800 dark:text-gray-200" data-i18n="activateBot">Activate Bot?</p>
                             </div>
                             <button onclick="setWebhook()" id="webhook-btn" class="w-14 h-14 bg-gradient-to-b from-[#ff6b4a] to-[#e53a1a] text-white rounded-full flex items-center justify-center shadow-[0_10px_20px_rgba(255,107,74,0.3)] transition-all hover:scale-110 active:scale-95 border-2 border-white/20">
                                 <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clip-rule="evenodd"></path></svg>
                             </button>
                        </div>
                    </div>

                    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6 mb-12">
                        <div class="bg-white dark:bg-zinc-800 rounded-[2rem] p-6 shadow-sm border border-gray-100 dark:border-zinc-700 flex flex-col items-center justify-center text-center transition-colors">
                            <div class="w-14 h-14 bg-gray-50 dark:bg-zinc-900 rounded-full flex items-center justify-center text-gray-700 dark:text-gray-300 mb-4 shadow-inner border border-gray-100 dark:border-zinc-800">
                                <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"></path></svg>
                            </div>
                            <span class="text-[10px] text-gray-400 font-bold uppercase tracking-widest mb-1" data-i18n="totalUsers">Total Users</span>
                            <span id="stat-total" class="text-3xl font-black text-gray-800 dark:text-white tracking-tighter">0</span>
                        </div>
                        <div class="bg-white dark:bg-zinc-800 rounded-[2rem] p-6 shadow-sm border border-gray-100 dark:border-zinc-700 flex flex-col items-center justify-center text-center transition-colors">
                            <div class="w-14 h-14 bg-gray-50 dark:bg-zinc-900 rounded-full flex items-center justify-center text-green-500 mb-4 shadow-inner border border-gray-100 dark:border-zinc-800">
                                <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                            </div>
                            <span class="text-[10px] text-gray-400 font-bold uppercase tracking-widest mb-1" data-i18n="verified">Verified</span>
                            <span id="stat-verified" class="text-3xl font-black text-gray-800 dark:text-white tracking-tighter">0</span>
                        </div>
                        <div class="bg-white dark:bg-zinc-800 rounded-[2rem] p-6 shadow-sm border border-gray-100 dark:border-zinc-700 flex flex-col items-center justify-center text-center transition-colors">
                            <div class="w-14 h-14 bg-gray-50 dark:bg-zinc-900 rounded-full flex items-center justify-center text-red-500 mb-4 shadow-inner border border-gray-100 dark:border-zinc-800">
                                <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"></path></svg>
                            </div>
                            <span class="text-[10px] text-gray-400 font-bold uppercase tracking-widest mb-1" data-i18n="blocked">Blocked</span>
                            <span id="stat-blocked" class="text-3xl font-black text-gray-800 dark:text-white tracking-tighter">0</span>
                        </div>
                        <div class="bg-white dark:bg-zinc-800 rounded-[2rem] p-6 shadow-sm border border-gray-100 dark:border-zinc-700 flex flex-col items-center justify-center text-center relative overflow-hidden transition-colors">
                            <div class="w-14 h-14 bg-gray-50 dark:bg-zinc-900 rounded-full flex items-center justify-center text-[#ff6b4a] mb-4 shadow-inner border border-gray-100 dark:border-zinc-800 relative z-10">
                                <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"></path></svg>
                            </div>
                            <span class="text-[10px] text-gray-400 font-bold uppercase tracking-widest mb-1 relative z-10" data-i18n="messages">Messages</span>
                            <span id="stat-msgs" class="text-3xl font-black text-gray-800 dark:text-white tracking-tighter relative z-10">0</span>
                        </div>
                    </div>

                    <div class="bg-white dark:bg-zinc-800 rounded-[2.5rem] shadow-sm border border-gray-100 dark:border-zinc-700 p-2 md:p-4 transition-colors">
                        <div class="flex justify-between items-center px-4 md:px-6 pt-4 pb-2">
                            <h3 class="text-2xl font-black text-gray-900 dark:text-white tracking-tight" data-i18n="summary">Summary</h3>
                            <button onclick="fetchUsers()" class="text-xs font-bold text-gray-500 dark:text-gray-400 hover:text-black dark:hover:text-white px-5 py-2 bg-gray-50 dark:bg-zinc-900 rounded-full transition-colors flex items-center gap-2 border border-gray-200 dark:border-zinc-700">
                                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> <span data-i18n="refresh">Refresh</span>
                            </button>
                        </div>
                        <div class="overflow-x-auto px-2">
                            <table class="w-full text-left min-w-[800px] border-separate border-spacing-y-3">
                                <thead>
                                    <tr class="text-gray-400 dark:text-gray-500 text-[11px] font-bold uppercase tracking-widest">
                                        <th class="px-6 py-2" data-i18n="colId">ID</th>
                                        <th class="px-6 py-2" data-i18n="colProfile">Profile</th>
                                        <th class="px-6 py-2" data-i18n="colStatus">Status</th>
                                        <th class="px-6 py-2" data-i18n="colAlert">Alert</th>
                                        <th class="px-6 py-2" data-i18n="colRules">Rules</th>
                                        <th class="px-6 py-2 text-right" data-i18n="colAction">Action</th>
                                    </tr>
                                </thead>
                                <tbody id="user-table-body" class="text-sm">
                                    <tr><td colspan="6" class="p-10 text-center text-gray-400 font-bold" data-i18n="loading">Loading records...</td></tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                <!-- ================= SETTINGS VIEW ================= -->
                <div id="view-settings" class="hidden fade-in">
                    <div class="mb-12">
                        <h1 class="text-4xl md:text-6xl font-black text-gray-900 dark:text-white tracking-tighter leading-none mb-3" data-i18n="settingsTitle">System Settings</h1>
                        <p class="text-gray-500 dark:text-gray-400 font-medium text-sm tracking-wide" data-i18n="settingsSub">Customize your dashboard experience.</p>
                    </div>

                    <div class="max-w-2xl flex flex-col gap-4">
                        <!-- Theme Toggle -->
                        <div class="flex justify-between items-center bg-white dark:bg-zinc-800 p-6 rounded-3xl shadow-sm border border-gray-100 dark:border-zinc-700 transition-colors">
                            <div>
                                <h3 class="font-bold text-lg text-gray-900 dark:text-white" data-i18n="themeTitle">Appearance (Dark Mode)</h3>
                                <p class="text-sm text-gray-500 dark:text-gray-400 font-medium mt-1" data-i18n="themeDesc">Switch between light and dark themes</p>
                            </div>
                            <button onclick="toggleTheme()" class="relative inline-flex h-8 w-14 items-center rounded-full transition-colors focus:outline-none" id="theme-toggle-bg">
                                <span class="inline-block h-6 w-6 transform rounded-full bg-white transition-transform shadow-sm" id="theme-toggle-dot"></span>
                            </button>
                        </div>

                        <!-- Language Toggle -->
                        <div class="flex justify-between items-center bg-white dark:bg-zinc-800 p-6 rounded-3xl shadow-sm border border-gray-100 dark:border-zinc-700 transition-colors">
                            <div>
                                <h3 class="font-bold text-lg text-gray-900 dark:text-white" data-i18n="langTitle">Language</h3>
                                <p class="text-sm text-gray-500 dark:text-gray-400 font-medium mt-1" data-i18n="langDesc">Switch interface language</p>
                            </div>
                            <button onclick="toggleLang()" class="px-5 py-2.5 bg-gray-100 dark:bg-zinc-900 hover:bg-gray-200 dark:hover:bg-zinc-700 rounded-xl font-bold text-gray-800 dark:text-white transition-colors" id="lang-btn-text">
                                EN / 中文
                            </button>
                        </div>
                    </div>
                </div>

            </div>
        </div>
    </div>

    <!-- Script: i18n & Logic -->
    <script>
        const API_BASE='/api'; 
        
        // --- i18n Dictionaries ---
        const i18n = {
            en: {
                loginTitle: "TGBOT", loginSub: "Please enter your supervisor ID", pwdPlaceholder: "ID Number", loginBtn: "Access Now", loginWait: "Verifying...",
                navDash: "Dashboard", navSet: "Settings", sysId: "System Identity", sysSub: "Logged in securely.", logout: "Sign Out",
                mainTitle: "Let's start<br>managing!", mainSub: "TG Bot Data & User Control Center",
                statusAction: "Status Action", activateBot: "Activate Bot?", totalUsers: "Total Users", verified: "Verified", blocked: "Blocked", messages: "Messages",
                summary: "Summary", refresh: "Refresh", colId: "ID", colProfile: "Profile", colStatus: "Status", colAlert: "Alert", colRules: "Rules", colAction: "Action",
                loading: "Loading records...", noData: "No records found.",
                settingsTitle: "System Settings", settingsSub: "Customize your dashboard experience.",
                themeTitle: "Appearance (Dark Mode)", themeDesc: "Switch between light and dark themes",
                langTitle: "Language", langDesc: "Switch interface language",
                
                // Dynamic JS Strings
                s_blocked: "Blocked", s_active: "Active", s_pending: "Pending",
                a_muted: "🔕 Muted", a_active: "🔔 Active",
                u_none: "No Username", u_unk: "Unknown",
                btnReset: "Reset",
                promptDel: "Delete this user completely?\\nThey will need to verify again next time."
            },
            zh: {
                loginTitle: "TGBOT管理中心", loginSub: "请输入主管 TG ID", pwdPlaceholder: "主管密码/ID", loginBtn: "进入系统", loginWait: "验证中...",
                navDash: "数据大盘", navSet: "系统设置", sysId: "管理员身份", sysSub: "已安全登录", logout: "退出系统",
                mainTitle: "掌控全局<br>轻松管理！", mainSub: "TG 机器人数据与用户控制中心",
                statusAction: "系统状态", activateBot: "激活机器人?", totalUsers: "总用户数", verified: "已验证放行", blocked: "拦截黑名单", messages: "消息记录",
                summary: "数据明细", refresh: "刷新数据", colId: "账号 ID", colProfile: "用户资料", colStatus: "身份状态", colAlert: "提醒状态", colRules: "违规次数", colAction: "操作",
                loading: "正在加载数据...", noData: "暂无任何数据记录。",
                settingsTitle: "系统设置", settingsSub: "个性化定制你的大盘体验。",
                themeTitle: "外观与主题 (Dark Mode)", themeDesc: "在亮色与暗色模式之间无缝切换",
                langTitle: "显示语言 (Language)", langDesc: "切换界面的显示语言",
                
                // Dynamic JS Strings
                s_blocked: "已拉黑", s_active: "正常", s_pending: "待验证",
                a_muted: "🔕 已静音", a_active: "🔔 提醒开",
                u_none: "无用户名", u_unk: "未知",
                btnReset: "重置",
                promptDel: "确定要彻底删除该用户并重置其状态吗？\\n用户下次发送消息将重新触发人机验证。"
            }
        };

        let currentLang = localStorage.getItem('lang') || 'en';
        let currentTheme = localStorage.getItem('theme') || 'light';

        window.onload=()=>{
            applyTheme();
            applyLang();
            if(localStorage.getItem('admin_id')) showDashboard();
        };

        // --- Theme Toggle ---
        function toggleTheme() {
            currentTheme = currentTheme === 'light' ? 'dark' : 'light';
            localStorage.setItem('theme', currentTheme);
            applyTheme();
        }
        function applyTheme() {
            const html = document.documentElement;
            const bg = document.getElementById('theme-toggle-bg');
            const dot = document.getElementById('theme-toggle-dot');
            if(currentTheme === 'dark') {
                html.classList.add('dark');
                if(bg) bg.classList.replace('bg-gray-200', 'bg-[#ff6b4a]');
                if(bg) bg.classList.replace('dark:bg-zinc-600', 'bg-[#ff6b4a]'); // fallback safety
                if(dot) dot.classList.replace('translate-x-1', 'translate-x-7');
            } else {
                html.classList.remove('dark');
                if(bg) bg.className = "relative inline-flex h-8 w-14 items-center rounded-full transition-colors focus:outline-none bg-gray-200 dark:bg-zinc-600";
                if(dot) dot.className = "inline-block h-6 w-6 transform rounded-full bg-white transition-transform shadow-sm translate-x-1";
            }
        }

        // --- Language Toggle ---
        function toggleLang() {
            currentLang = currentLang === 'en' ? 'zh' : 'en';
            localStorage.setItem('lang', currentLang);
            applyLang();
            if(!document.getElementById('dashboard-box').classList.contains('hidden')){
                fetchUsers(); // re-render table with new lang
            }
        }
        function applyLang() {
            const dict = i18n[currentLang];
            document.querySelectorAll('[data-i18n]').forEach(el => {
                const key = el.getAttribute('data-i18n');
                if(dict[key]) {
                    if(el.tagName === 'INPUT') el.placeholder = dict[key];
                    else el.innerHTML = dict[key];
                }
            });
            const langBtn = document.getElementById('lang-btn-text');
            if(langBtn) langBtn.innerText = currentLang === 'en' ? "🇺🇸 English" : "🇨🇳 简体中文";
        }

        // --- Navigation Tabs ---
        function switchTab(tab) {
            const vDash = document.getElementById('view-dashboard');
            const vSet = document.getElementById('view-settings');
            const nDashBg = document.getElementById('nav-dash-bg');
            const nDashDot = document.getElementById('nav-dash-dot');
            const nDashTxt = document.getElementById('nav-dash-text');
            const nSetBg = document.getElementById('nav-set-bg');
            const nSetDot = document.getElementById('nav-set-dot');
            const nSetTxt = document.getElementById('nav-set-text');

            if(tab === 'dashboard') {
                vDash.classList.replace('hidden', 'block'); vSet.classList.replace('block', 'hidden');
                nDashBg.classList.replace('bg-transparent', 'bg-white/10'); nDashBg.classList.remove('hover:bg-white/5');
                nDashDot.classList.replace('bg-gray-600', 'bg-[#ff6b4a]'); nDashDot.classList.replace('group-hover:bg-gray-400', 'shadow-[0_0_8px_rgba(255,107,74,0.8)]');
                nDashTxt.classList.replace('text-gray-400', 'text-white');
                
                nSetBg.classList.replace('bg-white/10', 'bg-transparent'); nSetBg.classList.add('hover:bg-white/5');
                nSetDot.classList.replace('bg-[#ff6b4a]', 'bg-gray-600'); nSetDot.classList.replace('shadow-[0_0_8px_rgba(255,107,74,0.8)]', 'group-hover:bg-gray-400');
                nSetTxt.classList.replace('text-white', 'text-gray-400');
            } else {
                vSet.classList.replace('hidden', 'block'); vDash.classList.replace('block', 'hidden');
                nSetBg.classList.replace('bg-transparent', 'bg-white/10'); nSetBg.classList.remove('hover:bg-white/5');
                nSetDot.classList.replace('bg-gray-600', 'bg-[#ff6b4a]'); nSetDot.classList.replace('group-hover:bg-gray-400', 'shadow-[0_0_8px_rgba(255,107,74,0.8)]');
                nSetTxt.classList.replace('text-gray-400', 'text-white');
                
                nDashBg.classList.replace('bg-white/10', 'bg-transparent'); nDashBg.classList.add('hover:bg-white/5');
                nDashDot.classList.replace('bg-[#ff6b4a]', 'bg-gray-600'); nDashDot.classList.replace('shadow-[0_0_8px_rgba(255,107,74,0.8)]', 'group-hover:bg-gray-400');
                nDashTxt.classList.replace('text-white', 'text-gray-400');
            }
        }

        // --- Core Logic ---
        async function login(){
            const btn=document.getElementById('login-btn'); const originalText=btn.innerText; btn.innerText=i18n[currentLang].loginWait;
            const p=document.getElementById('admin-pwd').value;if(!p){btn.innerText=originalText; return;}
            const r=await fetch(API_BASE+'/auth',{method:'POST',body:JSON.stringify({password:p})});
            if(r.ok){localStorage.setItem('admin_id',p);showDashboard()}else{alert('Authentication failed!');btn.innerText=originalText;}
        }
        function logout(){localStorage.removeItem('admin_id');document.getElementById('dashboard-box').classList.add('hidden');document.getElementById('login-box').classList.remove('hidden');document.getElementById('admin-pwd').value='';}
        async function showDashboard(){document.getElementById('login-box').classList.add('hidden');document.getElementById('dashboard-box').classList.replace('hidden','flex');await fetchStats();await fetchUsers();}
        
        async function fetchStats(){const a=localStorage.getItem('admin_id');const r=await fetch(API_BASE+'/stats?admin='+a);if(!r.ok)return logout();const d=await r.json();['total','verified','blocked','msgs'].forEach((k,i)=>document.getElementById('stat-'+k).innerText=[d.total,d.verified,d.blocked,d.messages][i]||0);}
        
        async function fetchUsers(){
            const dict = i18n[currentLang];
            const a=localStorage.getItem('admin_id');const r=await fetch(API_BASE+'/users?admin='+a);if(!r.ok)return;const u=await r.json();
            document.getElementById('user-table-body').innerHTML=u.map(x=>{
                let i={};try{i=JSON.parse(x.user_info_json||"{}")}catch(e){}
                const statusColor = x.is_blocked ? 'bg-[#ff4a2b]' : x.user_state === 'verified' ? 'bg-[#10b981]' : 'bg-[#f59e0b]';
                const statusText = x.is_blocked ? dict.s_blocked : x.user_state === 'verified' ? dict.s_active : dict.s_pending;
                return \`
                <tr class="group hover:bg-gray-50 dark:hover:bg-zinc-700/50 transition-colors">
                    <td class="px-6 py-4 rounded-l-3xl"><a href="tg://user?id=\${x.user_id}" class="font-mono text-xs font-bold text-gray-500 dark:text-gray-400 hover:text-[#ff6b4a] dark:hover:text-[#ff6b4a] transition-colors">\${x.user_id}</a></td>
                    <td class="px-6 py-4">
                        <div class="font-black text-gray-900 dark:text-gray-100">\${i.name||dict.u_unk}</div>
                        <div class="text-[11px] text-gray-400 dark:text-gray-500 font-bold mt-0.5 tracking-wide">\${i.username||dict.u_none}</div>
                    </td>
                    <td class="px-6 py-4">
                        <div class="inline-flex items-center gap-2 px-4 py-1.5 bg-white dark:bg-zinc-800 border border-gray-100 dark:border-zinc-700 shadow-sm rounded-full text-xs font-bold text-gray-700 dark:text-gray-200">
                            <span class="w-2 h-2 rounded-full \${statusColor} shadow-inner"></span>\${statusText}
                        </div>
                    </td>
                    <td class="px-6 py-4 font-bold text-xs \${i.is_muted?'text-gray-400':'text-gray-800 dark:text-gray-200'}">\${i.is_muted?dict.a_muted:dict.a_active}</td>
                    <td class="px-6 py-4 font-black text-gray-400 dark:text-gray-500">\${x.block_count||0}</td>
                    <td class="px-6 py-4 text-right rounded-r-3xl">
                        <button onclick="deleteUser('\${x.user_id}')" class="text-xs font-black px-5 py-2 bg-white dark:bg-zinc-800 text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-zinc-700 shadow-sm rounded-full hover:bg-red-50 dark:hover:bg-red-500/10 hover:text-red-500 dark:hover:text-red-400 hover:border-red-100 dark:hover:border-red-500/20 transition-all active:scale-95">\${dict.btnReset}</button>
                    </td>
                </tr>\`;
            }).join('')|| \`<tr><td colspan="6" class="p-10 text-center font-bold text-gray-400">\${dict.noData}</td></tr>\`;
        }
        
        async function deleteUser(uid){
            if(!confirm(i18n[currentLang].promptDel)) return;
            const a=localStorage.getItem('admin_id'); await fetch(API_BASE+'/users/'+uid+'?admin='+a, {method:'DELETE'}); fetchUsers(); fetchStats();
        }
        
        async function setWebhook(){
            const btn=document.getElementById('webhook-btn'); const originalHtml=btn.innerHTML; 
            btn.innerHTML='<svg class="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>';
            try{const r=await fetch(API_BASE+'/webhook',{method:'POST',body:JSON.stringify({admin:localStorage.getItem('admin_id')})});const d=await r.json();
            if(d.success){btn.innerHTML='<svg class="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path></svg>';}else{btn.innerHTML=originalHtml;alert("Failed");}}catch(e){btn.innerHTML=originalHtml;alert("Error");}
            setTimeout(()=>btn.innerHTML=originalHtml, 2000);
        }
    </script>
</body></html>
`;

export default {
    async fetch(request, env, ctx) {
        try { await dbMigrate(env); } catch (e) { return new Response(`初始化失败: ${e.message}`, { status: 500 }); }

        const url = new URL(request.url);

        if (request.method === "GET" && url.pathname === "/") {
            return new Response(ADMIN_HTML, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
        }

        if (url.pathname.startsWith("/api/")) {
            const getAdmin = async () => request.method === 'POST' ? (await request.clone().json()).password || (await request.clone().json()).admin : url.searchParams.get('admin');
            const admin = await getAdmin();
            if (!isPrimaryAdmin(admin, env)) return new Response("Unauthorized", { status: 401 });

            if (url.pathname === "/api/auth") return new Response(JSON.stringify({ success: true }));
            if (url.pathname === "/api/stats") {
                const total = await env.TG_BOT_DB.prepare("SELECT COUNT(*) as c FROM users").first('c');
                const verified = await env.TG_BOT_DB.prepare("SELECT COUNT(*) as c FROM users WHERE user_state = 'verified'").first('c');
                const blocked = await env.TG_BOT_DB.prepare("SELECT COUNT(*) as c FROM users WHERE is_blocked = 1").first('c');
                const messages = await env.TG_BOT_DB.prepare("SELECT COUNT(*) as c FROM messages").first('c');
                return new Response(JSON.stringify({ total, verified, blocked, messages }), { headers: { "Content-Type": "application/json" } });
            }
            if (url.pathname === "/api/users" && request.method === "GET") {
                const { results } = await env.TG_BOT_DB.prepare("SELECT * FROM users ORDER BY rowid DESC LIMIT 100").all();
                return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
            }
            if (url.pathname.startsWith("/api/users/") && request.method === "DELETE") {
                const targetUserId = url.pathname.split("/").pop();
                try {
                    const user = await env.TG_BOT_DB.prepare("SELECT topic_id FROM users WHERE user_id = ?").bind(targetUserId).first();
                    if (user && user.topic_id) await telegramApi(env.BOT_TOKEN, "closeForumTopic", { chat_id: env.ADMIN_GROUP_ID, message_thread_id: user.topic_id });
                } catch(e) {}
                await env.TG_BOT_DB.prepare("DELETE FROM users WHERE user_id = ?").bind(targetUserId).run();
                await env.TG_BOT_DB.prepare("DELETE FROM messages WHERE user_id = ?").bind(targetUserId).run();
                return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
            }
            if (url.pathname === "/api/webhook") {
                const tgRes = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook?url=${encodeURIComponent(`https://${url.host}/`)}`);
                return new Response(JSON.stringify({ success: (await tgRes.json()).ok }), { headers: { "Content-Type": "application/json" } });
            }
        }

        if (request.method === "POST" && url.pathname === "/") {
            try { ctx.waitUntil(handleUpdate(await request.json(), env)); } catch (e) { console.error(e); }
            return new Response("OK");
        }

        return new Response("Not Found", { status: 404 });
    },
};

// ==================== 核心业务与控制 ====================
async function handleUpdate(update, env) {
    if (update.message) {
        if (update.message.chat.type === "private") await handlePrivateMessage(update.message, env);
        else if (update.message.chat.id.toString() === env.ADMIN_GROUP_ID) await handleAdminReply(update.message, env);
    } else if (update.edited_message && update.edited_message.chat.type === "private") {
        await handleRelayEditedMessage(update.edited_message, env);
    } else if (update.callback_query) {
        await handleCallbackQuery(update.callback_query, env);
    } 
}

async function handlePrivateMessage(message, env) {
    const chatId = message.chat.id.toString();
    const text = message.text || "";
    
    const user = await dbUserGetOrCreate(chatId, env);
    
    if (user.is_blocked) return; 

    if (text === "/start" || text === "/help") {
        if (isPrimaryAdmin(chatId, env)) await handleAdminConfigStart(chatId, env);
        else await handleStart(chatId, env);
        return;
    }

    if (isPrimaryAdmin(chatId, env) || await isAdminUser(chatId, env)) {
        if (user.user_state !== "verified") {
            await dbUserUpdate(chatId, { user_state: "verified" }, env); 
            user.user_state = "verified";
        }
    }

    if (user.user_state === "pending_verification") await handleVerification(chatId, text, env);
    else if (user.user_state === "verified") await handleRelayToTopic(message, user, env); 
    else await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "请使用 /start 命令开始。" });
}

async function handleRelayToTopic(message, user, env) {
    const { from: userDetails, date } = message;
    const { userId, topicName, infoCard } = getUserInfo(userDetails, date);
    let topicId = user.topic_id;

    const createTopicForUser = async () => {
        const newTopic = await telegramApi(env.BOT_TOKEN, "createForumTopic", { chat_id: env.ADMIN_GROUP_ID, name: topicName });
        const newTopicId = newTopic.message_thread_id.toString();
        
        const { name, username } = getUserInfo(userDetails, date);
        const userInfoObj = { name, username, first_message_timestamp: date, is_muted: false };
        
        const buttons = getEnhancedInfoCardButtons(userId, user.is_blocked, false, newTopicId, env);

        const topicMsg = await telegramApi(env.BOT_TOKEN, "sendMessage", {
            chat_id: env.ADMIN_GROUP_ID, text: infoCard, message_thread_id: newTopicId, parse_mode: "HTML", reply_markup: buttons
        });
        userInfoObj.topic_msg_id = topicMsg.message_id.toString();

        let summaryTopicId = await getSummaryTopicId(env);
        if (summaryTopicId) {
            try {
                const summaryMsg = await telegramApi(env.BOT_TOKEN, "sendMessage", {
                    chat_id: env.ADMIN_GROUP_ID, text: infoCard, message_thread_id: summaryTopicId, parse_mode: "HTML", reply_markup: buttons
                });
                userInfoObj.summary_msg_id = summaryMsg.message_id.toString();
            } catch (e) {
                await dbConfigPut('summary_topic_id', '', env);
                summaryTopicId = await getSummaryTopicId(env); 
                if (summaryTopicId) {
                    try {
                        const retryMsg = await telegramApi(env.BOT_TOKEN, "sendMessage", {
                            chat_id: env.ADMIN_GROUP_ID, text: infoCard, message_thread_id: summaryTopicId, parse_mode: "HTML", reply_markup: buttons
                        });
                        userInfoObj.summary_msg_id = retryMsg.message_id.toString();
                    } catch(err) {}
                }
            }
        }

        await dbUserUpdate(userId, { topic_id: newTopicId, user_info: userInfoObj }, env);
        return newTopicId;
    };

    if (!topicId) {
        try { 
            topicId = await createTopicForUser(); 
        } 
        catch (e) { 
            await telegramApi(env.BOT_TOKEN, "sendMessage", { 
                chat_id: userId, 
                text: `抱歉，暂时无法连接客服（创建话题失败）。\n\n<b>系统错误:</b>\n<code>${escapeHtml(e.message)}</code>\n\n<i>(如您是管理员，请检查群组是否开启了话题，并核对机器人权限)</i>`,
                parse_mode: "HTML"
            }); 
            return; 
        }
    }

    try {
        const isMuted = user.user_info?.is_muted === true;
        await telegramApi(env.BOT_TOKEN, "copyMessage", { 
            chat_id: env.ADMIN_GROUP_ID, 
            from_chat_id: userId, 
            message_id: message.message_id, 
            message_thread_id: topicId,
            disable_notification: isMuted 
        });
    } catch (e) {
        const errMsg = (e.message || "").toLowerCase();
        if (errMsg.includes("not found") || errMsg.includes("closed") || errMsg.includes("deleted") || errMsg.includes("invalid")) {
            try {
                await dbUserUpdate(userId, { topic_id: null }, env);
                const newTopicId = await createTopicForUser();
                await telegramApi(env.BOT_TOKEN, "copyMessage", { chat_id: env.ADMIN_GROUP_ID, from_chat_id: userId, message_id: message.message_id, message_thread_id: newTopicId });
            } catch (err) {
                await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: `由于状态重置，消息转发失败，请稍后再试。\n错误: ${err.message}` });
            }
        } else {
            await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: `发送失败，该消息可能包含不支持的格式。\n错误: ${e.message}` });
        }
    }

    if (message.text) await dbMessageDataPut(userId, message.message_id.toString(), { text: message.text, date: message.date }, env);
}

async function handleCallbackQuery(callbackQuery, env) {
    const { data, message, id } = callbackQuery;
    const [action, userId] = data.split(':');

    if (action === 'pin_card') {
        await telegramApi(env.BOT_TOKEN, "pinChatMessage", { chat_id: message.chat.id, message_id: message.message_id, disable_notification: true });
        await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: id, text: "📌 已将此卡片在当前话题内置顶！" });
        return;
    }

    if (action === 'block_toggle' || action === 'mute_toggle') {
        const user = await dbUserGetOrCreate(userId, env);
        let isBlocked = user.is_blocked;
        let isMuted = user.user_info?.is_muted || false;

        if (action === 'block_toggle') isBlocked = !isBlocked;
        if (action === 'mute_toggle') isMuted = !isMuted;

        const updatedInfo = { ...(user.user_info || {}), is_muted: isMuted };
        await dbUserUpdate(userId, { is_blocked: isBlocked, block_count: 0, user_info: updatedInfo }, env);

        await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: id, text: "✅ 状态已同步更新！" });

        const newButtons = getEnhancedInfoCardButtons(userId, isBlocked, isMuted, user.topic_id, env);

        try { await telegramApi(env.BOT_TOKEN, "editMessageReplyMarkup", { chat_id: message.chat.id, message_id: message.message_id, reply_markup: newButtons }); } catch(e){}

        try {
            if (updatedInfo.topic_msg_id && message.message_id.toString() !== updatedInfo.topic_msg_id) {
                await telegramApi(env.BOT_TOKEN, "editMessageReplyMarkup", { chat_id: env.ADMIN_GROUP_ID, message_id: updatedInfo.topic_msg_id, reply_markup: newButtons });
            }
            if (updatedInfo.summary_msg_id && message.message_id.toString() !== updatedInfo.summary_msg_id) {
                await telegramApi(env.BOT_TOKEN, "editMessageReplyMarkup", { chat_id: env.ADMIN_GROUP_ID, message_id: updatedInfo.summary_msg_id, reply_markup: newButtons });
            }
        } catch(e) {}
    }

    if (action === 'reset_user') {
        const user = await env.TG_BOT_DB.prepare("SELECT topic_id FROM users WHERE user_id = ?").bind(userId).first();
        
        await env.TG_BOT_DB.prepare("DELETE FROM users WHERE user_id = ?").bind(userId).run();
        await env.TG_BOT_DB.prepare("DELETE FROM messages WHERE user_id = ?").bind(userId).run();
        
        await telegramApi(env.BOT_TOKEN, "answerCallbackQuery", { callback_query_id: id, text: "✅ 数据已彻底删档！该用户需要重新执行验证流程。" });
        
        try {
            await telegramApi(env.BOT_TOKEN, "editMessageText", {
                chat_id: message.chat.id,
                message_id: message.message_id,
                text: "<b>👤 此用户资料已被强制删档重置</b>\n---\n<i>相关数据已清空。该用户下次发送消息时将被要求重新回答人机验证。</i>",
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [] } 
            });
        } catch(e) {}
        
        if (user && user.topic_id) {
            try { await telegramApi(env.BOT_TOKEN, "closeForumTopic", { chat_id: env.ADMIN_GROUP_ID, message_thread_id: user.topic_id }); } catch(e){}
        }
        return;
    }
}

async function handleStart(chatId, env) {
    const welcomeMessage = await getConfig('welcome_msg', env, "欢迎！在使用之前，请先完成人机验证。");
    const verificationQuestion = await getConfig('verif_q', env, "问题：1+1=?\n提示：答案在机器人简介内。");
    await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: welcomeMessage });
    await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: verificationQuestion });
    await dbUserUpdate(chatId, { user_state: "pending_verification" }, env);
}
async function handleVerification(chatId, answer, env) {
    const expectedAnswer = await getConfig('verif_a', env, "3"); 
    if (answer.trim() === expectedAnswer.trim()) {
        await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "✅ 验证通过！您现在可以发送消息了。" });
        await dbUserUpdate(chatId, { user_state: "verified" }, env);
    } else await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "❌ 验证失败！请查看简介查找答案。" });
}
async function handleAdminConfigStart(chatId, env) {
    const menuText = `⚙️ <b>机器人主配置菜单</b>\n请直接访问下方网址进入可视化面板管理：`;
    const menuKeyboard = { inline_keyboard: [[{ text: "🖥️ 进入 Web 管理中心", url: `https://${env.WORKER_HOST || "请访问您绑定的CF域名"}/` }]] };
    await dbAdminStateDelete(chatId, env);
    await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: chatId, text: menuText, parse_mode: "HTML", reply_markup: menuKeyboard });
}
async function handleAdminReply(message, env) {
    if (!message.is_topic_message || !message.message_thread_id) return;
    if (message.chat.id.toString() !== env.ADMIN_GROUP_ID.toString() || (message.from && message.from.is_bot)) return;
    if (!(await isAdminUser(message.from.id.toString(), env))) return;
    const topicId = message.message_thread_id.toString();
    const userId = await dbTopicUserGet(topicId, env);
    if (!userId) return;
    try { await telegramApi(env.BOT_TOKEN, "copyMessage", { chat_id: userId, from_chat_id: message.chat.id, message_id: message.message_id });
    } catch (e) { if (message.text) await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: userId, text: message.text }); }
}
async function handleRelayEditedMessage(editedMessage, env) {
    const userId = editedMessage.from.id.toString();
    const userData = await dbUserGetOrCreate(userId, env);
    if (!userData.topic_id) return;
    const storedData = await dbMessageDataGet(userId, editedMessage.message_id.toString(), env);
    let originalText = storedData ? storedData.text : "[原始内容无法获取]";
    if (storedData) await dbMessageDataPut(userId, editedMessage.message_id.toString(), { text: editedMessage.text || '', date: storedData.date }, env);
    const notificationText = `⚠️ <b>用户修改了消息</b>\n---\n<b>原内容:</b> <code>${escapeHtml(originalText)}</code>\n<b>新内容:</b> ${escapeHtml(editedMessage.text)}`;
    await telegramApi(env.BOT_TOKEN, "sendMessage", { chat_id: env.ADMIN_GROUP_ID, text: notificationText, message_thread_id: userData.topic_id, parse_mode: "HTML" });
}
