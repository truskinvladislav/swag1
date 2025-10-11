// userbot_with_debug.js
require("dotenv").config();
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const input = require("input");

// parseInt(, 10);
// process.env.API_ID
const apiId = parseInt(process.env.API_ID, 10)
const apiHash = process.env.API_HASH;
let stringSession = process.env.STRING_SESSION || "";

console.log("STRING_SESSION загружен?", process.env.STRING_SESSION?.slice(0, 15), "длина:", process.env.STRING_SESSION?.length);


const targetGroupName = process.env.TARGET_GROUP_NAME; // пример: ORDERS
const logGroupTitle = process.env.LOG_GROUP_TITLE;     // пример: Reklama (или можно дать ID)
const keywords = process.env.KEYWORDS ? process.env.KEYWORDS.split(",") : [];



// TARGET_FOLDER_ID из .env (если пуст — будет null)
const rawFolder = process.env.TARGET_FOLDER_ID;
const targetFolderId = rawFolder ? parseInt(rawFolder, 10) : null;
console.log('API_ID:', apiId);
console.log('API_HASH exists:', !!apiHash);

if (!apiId || !apiHash) {
    console.error('API_ID:', process.env.API_ID);
    console.error('API_HASH:', process.env.API_HASH ? 'exists' : 'missing');
    throw new Error('API credentials are missing');
}


const client = new TelegramClient(new StringSession(stringSession), apiId, apiHash, { connectionRetries: 5 });

let resolvedLogPeer = null;     // id группы логов (если нашли)
let resolvedTargetPeer = null;  // id targetGroupName (для ключевых слов)

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Попытаться резолвить диалог по title/username/числовому id
async function resolveDialogPeer(identifier) {
    if (!identifier) return null;
    // если это числовой id в .env — используем как есть
    if (/^-?\d+$/.test(String(identifier).trim())) {
        return Number(identifier);
    }
    const dialogs = await client.getDialogs();
    const found = dialogs.find(d => d.title === identifier || d.username === identifier || String(d.id) === identifier);
    return found ? found.id : null;
}

// Универсальная отправка — принимает title/username/ID
async function sendToGroup(groupIdentifier, text) {
    try {
        let peer = groupIdentifier;

        // если это специальный лог-тайтл и мы уже резолвили — используем id
        if (groupIdentifier === logGroupTitle && resolvedLogPeer) peer = resolvedLogPeer;
        else if (groupIdentifier === targetGroupName && resolvedTargetPeer) peer = resolvedTargetPeer;
        else if (typeof groupIdentifier === "string" && /^-?\d+$/.test(groupIdentifier.trim())) {
            peer = Number(groupIdentifier);
        } else if (typeof groupIdentifier === "string") {
            // попробуем найти по title/username прямо сейчас
            const dialogs = await client.getDialogs();
            const found = dialogs.find(d => d.title === groupIdentifier || d.username === groupIdentifier);
            if (found) peer = found.id;
            // если не найден — оставим строку (client.sendMessage попытается резолвить username)
        }

        await client.sendMessage(peer, { message: text });
    } catch (err) {
        console.error(`Ошибка при отправке в "${groupIdentifier}":`, err);
    }
}

// ===== Рассылка сообщений из Избранного по папке rozyob раз в 3 минуты =====
async function broadcastFromMe() {
    let currentIndex = 0;

    while (true) {
        try {
            const dialogs = await client.getDialogs();
            const groups = dialogs.filter(d => (d.isGroup || d.isChannel) && d.folderId === targetFolderId);

            if (!groups.length) {
                console.log("⚠ Нет групп в папке TARGET_FOLDER_ID");
                await sleep(60000);
                continue;
            }

            const lastMessage = (await client.getMessages("me", { limit: 1 }))[0];
            if (!lastMessage) {
                console.log("⚠ Нет сообщений в Избранном");
                await sleep(60000);
                continue;
            }

            const group = groups[currentIndex % groups.length];

            try {
                // Пересылаем сообщение напрямую, чтобы сохранились премиум-эмодзи, стикеры и медиа
                const forwardedArr = await client.forwardMessages(group.entity, {
                    messages: [lastMessage.id],
                    fromPeer: "me"
                });

                const forwarded = Array.isArray(forwardedArr) ? forwardedArr[0] : forwardedArr;
                const msgIdToDelete = forwarded?.id;

                // Логируем
                const logText = `✅ Переслано сообщение в "${group.title}"\nID сообщения: ${lastMessage.id}`;
                if (resolvedLogPeer) await sendToGroup(resolvedLogPeer, logText);
                else await sendToGroup(logGroupTitle, logText);

                // Удаление через 1 минуту
                if (msgIdToDelete) {
                    setTimeout(async () => {
                        try {
                            await client.deleteMessages(group.id, [msgIdToDelete]);
                            console.log(`🗑 Сообщение удалено из "${group.title}"`);
                        } catch (err) {
                            console.error(`Ошибка удаления сообщения из "${group.title}":`, err);
                        }
                    }, 60 * 1000);
                }

            } catch (err) {
                console.error(`Ошибка пересылки в "${group.title}":`, err);
                // fallback — отправляем текст, если пересылка невозможна
                if (lastMessage.message) {
                    await client.sendMessage(group.id, { message: lastMessage.message });
                }
            }

            currentIndex++;
            console.log("⏱ Жду 3 минуты до следующей группы...");
            await sleep(3 * 60 * 1000);

        } catch (err) {
            console.error("Ошибка в broadcastFromMe:", err);
            await sleep(20000);
        }
    }
}





const recentMessages = new Map(); // Хранилище для защиты от дублей

client.addEventHandler(async (event) => {
    try {
        const messageText = event.message.message?.toLowerCase();
        if (!messageText || messageText.length > 15) return;

        if (keywords.some(k => messageText.includes(k))) {
            let chat, sender;
            try { chat = await event.message.getChat(); } catch { }
            try { sender = await event.message.getSender(); } catch { }

            // Определяем имя/username отправителя
            let senderName = "[UNKNOWN]";
            let senderId = sender?.id;
            if (sender?.username) {
                senderName = `@${sender.username}`;
            } else {
                try {
                    const fullSender = await client.getEntity(event.message.senderId);
                    if (fullSender?.username) {
                        senderName = `@${fullSender.username}`;
                    } else if (fullSender?.firstName) {
                        senderName = fullSender.firstName + (fullSender.lastName ? " " + fullSender.lastName : "");
                    } else {
                        senderName = `[ID:${fullSender.id}]`;
                    }
                    senderId = fullSender?.id;
                } catch {
                    senderName = sender?.id ? `[ID:${sender.id}]` : "[UNKNOWN]";
                }
            }

            // ===== АНТИСПАМ-ФИЛЬТР =====
            const uniqueKey = `${senderId}_${messageText}`; // уникальная комбинация (пользователь + текст)
            if (recentMessages.has(uniqueKey)) {
                // Уже было такое сообщение в последние 3 минуты — пропускаем
                return;
            }

            // Добавляем в хранилище и ставим таймер на удаление
            recentMessages.set(uniqueKey, true);
            setTimeout(() => recentMessages.delete(uniqueKey), 3 * 60 * 1000); // удаляем через 3 минуты

            // ===== Формирование и отправкаs =====
            const groupName = chat?.title || `[ID:${chat?.id}]`;
            const msgLink = chat?.username
                ? `https://t.me/${chat.username}/${event.message.id}`
                : `[ID:${chat?.id}, msgId:${event.message.id}]`;
            const groupLink = chat?.username ? `https://t.me/${chat.username}` : `[ID:${chat?.id}]`;

            const text = `[⚡] ${senderName} | ${groupName}\n"${event.message.message}"\n🔗 ${msgLink}\n🌐 ${groupLink}`;

            // используем resolvedTargetPeer если есть
            if (resolvedTargetPeer) {
                await sendToGroup(resolvedTargetPeer, text);
            } else {
                await sendToGroup(targetGroupName, text);
            }
        }
    } catch (err) {
        console.error("Ошибка мониторинга ключевых слов:", err);
    }
}, new NewMessage({ incoming: true }));



// ===== Запуск клиента и резолв групп =====
async function startClient() {
    if (!stringSession || stringSession.trim() === "") {
        await client.start({
            phoneNumber: async () => await input.text("Введите номер телефона: "),
            password: async () => await input.text("Введите пароль (2FA): "),
            phoneCode: async () => await input.text("Введите код из Telegram: "),
            onError: (err) => console.log(err),
        });
        stringSession = client.session.save();
        console.log("✅ UserBot запущен! Скопируй STRING_SESSION в .env");
        console.log(stringSession);
    } else {
        await client.connect();
        console.log("✅ UserBot подключен с существующей сессией!");
    }

    // Попробуем резолвить лог-группу и цель для ключевых слов
    if (logGroupTitle) {
        resolvedLogPeer = await resolveDialogPeer(logGroupTitle);
        if (resolvedLogPeer) console.log("🔎 LOG_GROUP_TITLE резолвлен в id:", resolvedLogPeer);
        else console.warn("⚠ LOG_GROUP_TITLE не найден по title/username. Можно указать ID в LOG_GROUP_TITLE в .env");
    }
    if (targetGroupName) {
        resolvedTargetPeer = await resolveDialogPeer(targetGroupName);
        if (resolvedTargetPeer) console.log("🔎 TARGET_GROUP_NAME резолвлен в id:", resolvedTargetPeer);
        else console.warn("⚠ TARGET_GROUP_NAME не найден по title/username. Можно указать ID в TARGET_GROUP_NAME в .env");
    }
}

// ===== Главный запуск =====
(async () => {
    await startClient();
    broadcastFromMe();
})();


