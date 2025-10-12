require("dotenv").config();
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const input = require("input");

const apiId = parseInt(process.env.API_ID, 10);
const apiHash = process.env.API_HASH;
let stringSession = process.env.STRING_SESSION || "";

const targetGroupName = process.env.TARGET_GROUP_NAME; // например, ORDERS
const keywords = process.env.KEYWORDS ? process.env.KEYWORDS.split(",") : [];

// TARGET_FOLDER_ID из .env (если пуст — будет null)
const rawFolder = process.env.TARGET_FOLDER_ID;
// const targetFolderId = rawFolder ? parseInt(rawFolder, 10) : null;

if (!apiId || !apiHash) {
    console.error('API_ID или API_HASH отсутствуют в .env');
    throw new Error('API credentials are missing');
}

const client = new TelegramClient(new StringSession(stringSession), apiId, apiHash, { connectionRetries: 5 });

let resolvedTargetPeer = null;  // id targetGroupName (куда отправлять сообщения с ключевыми словами)

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Попытаться резолвить диалог по title/username/числовому id
async function resolveDialogPeer(identifier) {
    if (!identifier) return null;
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

        if (groupIdentifier === targetGroupName && resolvedTargetPeer) peer = resolvedTargetPeer;
        else if (typeof groupIdentifier === "string" && /^-?\d+$/.test(groupIdentifier.trim())) {
            peer = Number(groupIdentifier);
        } else if (typeof groupIdentifier === "string") {
            const dialogs = await client.getDialogs();
            const found = dialogs.find(d => d.title === groupIdentifier || d.username === groupIdentifier);
            if (found) peer = found.id;
        }

        await client.sendMessage(peer, { message: text });
    } catch (err) {
        console.error(`Ошибка при отправке в "${groupIdentifier}":`, err);
    }
}

const recentMessages = new Map(); // Хранилище для защиты от дублей

client.addEventHandler(async (event) => {
    try {
        const messageText = event.message.message?.toLowerCase();
        if (!messageText || messageText.length > 15) return;

        // Проверяем, что сообщение пришло из группы в нужной папке
        const chat = await event.message.getChat();
        // if (!chat || (chat.folderId !== rawFolder)) {
        //     // Если чат не из нужной папки — игнорируем
        //     return;
        // }

        if (keywords.some(k => messageText.includes(k))) {
            const sender = await event.message.getSender();

            let senderName = "[UNKNOWN]";
            let senderId = sender?.id;

            if (sender?.username) {
                senderName = `@${sender.username}`;
            } else if (sender?.firstName) {
                senderName = sender.firstName + (sender.lastName ? " " + sender.lastName : "");
            } else if (senderId) {
                senderName = `[ID:${senderId}]`;
            }

            // Антиспам: проверяем, не было ли такого сообщения недавно
            const uniqueKey = `${senderId}_${messageText}`;
            if (recentMessages.has(uniqueKey)) return;
            recentMessages.set(uniqueKey, true);
            setTimeout(() => recentMessages.delete(uniqueKey), 3 * 60 * 1000);

            // Формируем сообщение для отправки
            const groupName = chat.title || `[ID:${chat.id}]`;
            const msgLink = chat.username
                ? `https://t.me/${chat.username}/${event.message.id}`
                : `[ID:${chat.id}, msgId:${event.message.id}]`;

            const text = `[⚡] ${senderName} | ${groupName}\n"${event.message.message}"\n🔗 ${msgLink}`;

            // Отправляем сообщение в целевую группу
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

// Запуск клиента и резолв targetGroupName
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

    if (targetGroupName) {
        resolvedTargetPeer = await resolveDialogPeer(targetGroupName);
        if (resolvedTargetPeer) console.log("🔎 TARGET_GROUP_NAME резолвлен в id:", resolvedTargetPeer);
        else console.warn("⚠ TARGET_GROUP_NAME не найден по title/username. Можно указать ID в TARGET_GROUP_NAME в .env");
    }
}

// Главный запуск
(async () => {
    await startClient();
    // Убираем broadcastFromMe, если не нужен
})();
