/**
 * Telegram 双向机器人 Cloudflare Worker (网页大盘 + TG内建控制台版)
 * 1. 根目录直接访问 Web 管理面板
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
        // 有用户名直达，界面极其清爽
        usernameDisplay = `<a href="https://t.me/${user.username}">@${escapeHtml(user.username)}</a>`;
        idDisplay = `<code>${userId}</code>`;
    } else {
        // 无用户名，自动追加备用跳转（防呆防丢）
        usernameDisplay = "无";
        idDisplay = `<code>${userId}</code> <a href="tg://user?id=${userId}">[🔗 查主页]</a>`;
    }
    
    // ⭐ 将昵称用 <b> 标签原生加粗，安全免疫一切花字 Bug ⭐
    const infoCard = `<b>👤 用户资料卡</b>\n---\n• 昵称: <b>${escapeHtml(rawName)}</b>\n• 用户名: ${usernameDisplay}\n• ID: ${idDisplay}\n• 连接时间: <code>${timestamp}</code>`;

    return { 
        userId, 
        name: rawName, 
        username: user.username ? `@${user.username}` : "无", 
        topicName, 
        infoCard 
    };
}

// ⭐ 获取汇总话题 ID (自动创建) ⭐
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

// ==================== Web 网页代码 ====================
const ADMIN_HTML = `
<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>传话筒管理中心</title><script src="https://cdn.tailwindcss.com"></script>
<style>body{background:linear-gradient(135deg,#f5f7fa 0%,#c3cfe2 100%);min-height:100vh}.glass{background:rgba(255,255,255,0.85);backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,0.4);box-shadow:0 8px 32px rgba(31,38,135,0.1)}.fade-in{animation:fadeIn 0.4s ease-in-out}@keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-thumb{background:#cbd5e1;border-radius:4px}</style></head>
<body class="flex items-center justify-center p-4 md:p-10">
    <div id="login-box" class="glass rounded-2xl p-8 max-w-sm w-full fade-in">
        <div class="text-center mb-6"><h2 class="text-2xl font-bold text-gray-800">传话筒管理中心</h2><p class="text-sm text-gray-500 mt-2">请输入主管 TG ID</p></div>
        <input type="password" id="admin-pwd" placeholder="主管 TG ID" class="w-full px-4 py-3 rounded-xl border border-gray-300 focus:ring-2 focus:ring-blue-400 focus:outline-none mb-4">
        <button onclick="login()" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-xl shadow-lg">进入系统</button>
    </div>
    <div id="dashboard-box" class="glass rounded-3xl p-6 md:p-8 max-w-6xl w-full hidden fade-in flex flex-col h-full max-h-[90vh]">
        <div class="flex justify-between items-center mb-6 border-b border-gray-200 pb-4 shrink-0"><h1 class="text-2xl md:text-3xl font-bold text-gray-800">🤖 数据中心</h1><button onclick="logout()" class="text-sm text-red-500 font-semibold px-4 py-2 bg-red-50 rounded-lg">退出</button></div>
        <div class="overflow-y-auto flex-1 pr-2">
            <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                <div class="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 flex flex-col items-center"><span class="text-gray-500 text-sm">👥 总连接用户</span><span id="stat-total" class="text-3xl font-black text-gray-800 mt-2">-</span></div>
                <div class="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 flex flex-col items-center"><span class="text-green-600 text-sm">✅ 已验证放行</span><span id="stat-verified" class="text-3xl font-black text-green-500 mt-2">-</span></div>
                <div class="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 flex flex-col items-center"><span class="text-red-500 text-sm">🚫 拦截黑名单</span><span id="stat-blocked" class="text-3xl font-black text-red-500 mt-2">-</span></div>
                <div class="bg-white p-5 rounded-2xl shadow-sm border border-gray-100 flex flex-col items-center"><span class="text-blue-500 text-sm">📝 消息修改记录</span><span id="stat-msgs" class="text-3xl font-black text-blue-500 mt-2">-</span></div>
            </div>
            <div class="bg-blue-50 border border-blue-100 rounded-2xl p-5 mb-8 flex flex-col md:flex-row items-center justify-between">
                <div><h3 class="text-lg font-bold text-blue-800 mb-1">系统状态控制</h3><p class="text-sm text-blue-600">刚部署或无反应点右边激活。</p></div>
                <button onclick="setWebhook()" id="webhook-btn" class="mt-4 md:mt-0 bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 px-8 rounded-xl shadow">⚡ 一键激活机器人</button>
            </div>
            <div class="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
                <div class="p-5 border-b border-gray-100 bg-gray-50 flex justify-between items-center"><h3 class="text-lg font-bold text-gray-800">📋 用户明细汇总</h3><button onclick="fetchUsers()" class="text-sm text-blue-500 hover:text-blue-700 font-medium">🔄 刷新列表</button></div>
                <div class="overflow-x-auto"><table class="w-full text-left border-collapse min-w-[750px]">
                    <thead><tr class="bg-white text-gray-400 text-xs uppercase border-b border-gray-100"><th class="p-4">TG ID</th><th class="p-4">昵称 / 用户名</th><th class="p-4">身份状态</th><th class="p-4">静音状态</th><th class="p-4">违规</th><th class="p-4">操作</th></tr></thead>
                    <tbody id="user-table-body" class="text-sm text-gray-700 divide-y divide-gray-50"><tr><td colspan="6" class="p-8 text-center text-gray-400">加载中...</td></tr></tbody>
                </table></div>
            </div>
        </div>
    </div>
    <script>
        const API_BASE='/api'; window.onload=()=>{if(localStorage.getItem('admin_id'))showDashboard();};
        async function login(){const p=document.getElementById('admin-pwd').value;if(!p)return alert('请输入密码');const r=await fetch(API_BASE+'/auth',{method:'POST',body:JSON.stringify({password:p})});if(r.ok){localStorage.setItem('admin_id',p);showDashboard()}else alert('密码错误！');}
        function logout(){localStorage.removeItem('admin_id');document.getElementById('dashboard-box').classList.add('hidden');document.getElementById('login-box').classList.remove('hidden');document.getElementById('admin-pwd').value='';}
        async function showDashboard(){document.getElementById('login-box').classList.add('hidden');document.getElementById('dashboard-box').classList.remove('hidden');await fetchStats();await fetchUsers();}
        async function fetchStats(){const a=localStorage.getItem('admin_id');const r=await fetch(API_BASE+'/stats?admin='+a);if(!r.ok)return logout();const d=await r.json();['total','verified','blocked','msgs'].forEach((k,i)=>document.getElementById('stat-'+k).innerText=[d.total,d.verified,d.blocked,d.messages][i]||0);}
        async function fetchUsers(){const a=localStorage.getItem('admin_id');const r=await fetch(API_BASE+'/users?admin='+a);if(!r.ok)return;const u=await r.json();
            document.getElementById('user-table-body').innerHTML=u.map(x=>{
                let i={};try{i=JSON.parse(x.user_info_json||"{}")}catch(e){}
                return \`<tr class="hover:bg-blue-50 transition"><td class="p-4 font-mono text-blue-600"><a href="tg://user?id=\${x.user_id}">⍈ \${x.user_id}</a></td><td class="p-4">\${i.name||'未知'}<br><span class="text-xs text-gray-500">\${i.username||'无'}</span></td><td class="p-4">\${x.is_blocked?'<span class="px-2 py-1 bg-red-100 text-red-600 rounded text-xs font-bold">🚫 拉黑</span>':x.user_state==='verified'?'<span class="px-2 py-1 bg-green-100 text-green-600 rounded text-xs font-bold">✅ 正常</span>':'<span class="px-2 py-1 bg-yellow-100 text-yellow-600 rounded text-xs font-bold">⏳ 待验证</span>'}</td><td class="p-4">\${i.is_muted?'🔕 已静音':'🔔 提醒开'}</td><td class="p-4">\${x.block_count||0}次</td><td class="p-4"><button onclick="deleteUser('\${x.user_id}')" class="text-xs px-3 py-1.5 bg-red-100 text-red-600 rounded hover:bg-red-200 font-bold transition">重置</button></td></tr>\`;
            }).join('')||'<tr><td colspan="6" class="p-8 text-center">暂无数据</td></tr>';
        }
        async function deleteUser(uid){
            if(!confirm('确定要彻底删除该用户并重置其状态吗？\\n用户下次发送消息将重新触发人机验证。')) return;
            const a=localStorage.getItem('admin_id');
            await fetch(API_BASE+'/users/'+uid+'?admin='+a, {method:'DELETE'});
            fetchUsers(); fetchStats();
        }
        async function setWebhook(){const b=document.getElementById('webhook-btn');b.innerText="处理中...";try{const r=await fetch(API_BASE+'/webhook',{method:'POST',body:JSON.stringify({admin:localStorage.getItem('admin_id')})});const d=await r.json();alert(d.success?"✅ 激活成功！":"❌ 失败");}catch(e){alert("出错");}b.innerText="⚡ 一键激活机器人";}
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

// ⭐ 回调查询处理 ⭐
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
