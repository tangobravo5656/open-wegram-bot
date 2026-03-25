/**
 * Open Wegram Bot - Core Logic
 * Shared code between Cloudflare Worker and Vercel deployments
 */

export function validateSecretToken(token) {
    return token.length > 15 && /[A-Z]/.test(token) && /[a-z]/.test(token) && /[0-9]/.test(token);
}

export function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {'Content-Type': 'application/json'}
    });
}

export async function postToTelegramApi(token, method, body) {
    return fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body)
    });
}

export async function handleInstall(request, ownerUid, botToken, prefix, secretToken) {
    if (!validateSecretToken(secretToken)) {
        return jsonResponse({
            success: false,
            message: 'Secret token must be at least 16 characters and contain uppercase letters, lowercase letters, and numbers.'
        }, 400);
    }

    const url = new URL(request.url);
    const baseUrl = `${url.protocol}//${url.hostname}`;
    const webhookUrl = `${baseUrl}/${prefix}/webhook/${ownerUid}/${botToken}`;

    try {
        const response = await postToTelegramApi(botToken, 'setWebhook', {
            url: webhookUrl,
            allowed_updates: ['message', 'edited_message'],
            secret_token: secretToken
        });

        const result = await response.json();
        if (result.ok) {
            return jsonResponse({success: true, message: 'Webhook successfully installed.'});
        }

        return jsonResponse({success: false, message: `Failed to install webhook: ${result.description}`}, 400);
    } catch (error) {
        return jsonResponse({success: false, message: `Error installing webhook: ${error.message}`}, 500);
    }
}

export async function handleUninstall(botToken, secretToken) {
    if (!validateSecretToken(secretToken)) {
        return jsonResponse({
            success: false,
            message: 'Secret token must be at least 16 characters and contain uppercase letters, lowercase letters, and numbers.'
        }, 400);
    }

    try {
        const response = await postToTelegramApi(botToken, 'deleteWebhook', {})

        const result = await response.json();
        if (result.ok) {
            return jsonResponse({success: true, message: 'Webhook successfully uninstalled.'});
        }

        return jsonResponse({success: false, message: `Failed to uninstall webhook: ${result.description}`}, 400);
    } catch (error) {
        return jsonResponse({success: false, message: `Error uninstalling webhook: ${error.message}`}, 500);
    }
}

export async function handleWebhook(request, ownerUid, botToken, config) {
    if (config.secretToken !== request.headers.get('X-Telegram-Bot-Api-Secret-Token')) {
        return new Response('Unauthorized', {status: 401});
    }

    const update = await request.json();

    // 监听消息编辑
    if (update.edited_message) {
        if (!config.MESSAGE_MAP) return new Response('OK'); // 如果没有配置 KV，则直接忽略
        const edited = update.edited_message;
        const chatId = edited.chat.id.toString();
        const msgId = edited.message_id;
        try {
            const mapped = await config.MESSAGE_MAP.get(`msg:${chatId}:${msgId}`, "json");
            if (mapped && mapped.targetChatId && mapped.targetMsgId) {
                let method = null;
                const payload = { chat_id: mapped.targetChatId, message_id: mapped.targetMsgId };
                let mediaType = null;
                let mediaId = null;

                // 1. 尝试判断它纯文字还是媒体
                if (edited.text) {
                    method = 'editMessageText';
                    payload.text = edited.text;
                    if (edited.entities) payload.entities = edited.entities;
                } else {
                    if (edited.photo) {
                        mediaType = 'photo';
                        mediaId = edited.photo[edited.photo.length - 1].file_id; // 取最高清分辨率的图片
                    } else if (edited.video) { mediaType = 'video'; mediaId = edited.video.file_id; }
                    else if (edited.document) { mediaType = 'document'; mediaId = edited.document.file_id; }
                    else if (edited.animation) { mediaType = 'animation'; mediaId = edited.animation.file_id; }
                    else if (edited.audio) { mediaType = 'audio'; mediaId = edited.audio.file_id; }

                    if (mediaType && mediaId) {
                        method = 'editMessageMedia';
                        payload.media = {
                            type: mediaType,
                            media: mediaId,
                            caption: edited.caption || '',
                            caption_entities: edited.caption_entities
                        };
                    } else if (edited.caption !== undefined) {
                        method = 'editMessageCaption';
                        payload.caption = edited.caption;
                        if (edited.caption_entities) payload.caption_entities = edited.caption_entities;
                    }
                }

                if (chatId !== ownerUid) { // 发送自用户 -> 管理员，需要挂载发件人信息
                    const sn = edited.chat.username ? `@${edited.chat.username}` : [edited.chat.first_name, edited.chat.last_name].filter(Boolean).join(' ');
                    payload.reply_markup = { inline_keyboard: [[{ text: `🔓 From: ${sn} (${chatId})`, url: `tg://user?id=${chatId}` }]] };
                }

                if (method) {
                    const editResp = await postToTelegramApi(botToken, method, payload);
                    const editResJson = await editResp.json();
                    
                    // 如果编辑失败 (例如: Telegram 不允许直接把 "纯文字消息" edit 成 "图片消息")
                    // 我们直接执行优雅降级：删除旧的纯文本消息，重新 Copy 这条带图片的全新消息过去！
                    if (!editResJson.ok) {
                        await postToTelegramApi(botToken, 'deleteMessage', { 
                            chat_id: mapped.targetChatId, 
                            message_id: mapped.targetMsgId 
                        });
                        
                        const copyPayload = {
                            chat_id: mapped.targetChatId,
                            from_chat_id: chatId,
                            message_id: msgId
                        };
                        if (chatId !== ownerUid) copyPayload.reply_markup = payload.reply_markup;
                        
                        const copyResp = await postToTelegramApi(botToken, 'copyMessage', copyPayload);
                        const copyResJson = await copyResp.json();
                        // 覆盖保存新的映射ID，以防后续他又修改了图片
                        if (copyResJson.ok && copyResJson.result) {
                            await config.MESSAGE_MAP.put(`msg:${chatId}:${msgId}`, JSON.stringify({
                                targetChatId: mapped.targetChatId,
                                targetMsgId: copyResJson.result.message_id
                            }), {expirationTtl: 172800});
                        }
                    }
                }
            }
        } catch(e) { console.error('Map parsing error', e); }
        return new Response('OK');
    }

    if (!update.message) {
        return new Response('OK');
    }

    const message = update.message;
    const reply = message.reply_to_message;
    try {
        if (reply && message.chat.id.toString() === ownerUid) {
            const rm = reply.reply_markup;
            if (rm && rm.inline_keyboard && rm.inline_keyboard.length > 0) {
                let senderUid = rm.inline_keyboard[0][0].callback_data;
                if (!senderUid) {
                    senderUid = rm.inline_keyboard[0][0].url.split('tg://user?id=')[1];
                }

                const response = await postToTelegramApi(botToken, 'copyMessage', {
                    chat_id: parseInt(senderUid),
                    from_chat_id: message.chat.id,
                    message_id: message.message_id
                });
                
                if (config.MESSAGE_MAP) {
                    try {
                        const result = await response.json();
                        if (result.ok && result.result) {
                            await config.MESSAGE_MAP.put(`msg:${ownerUid}:${message.message_id}`, JSON.stringify({
                                targetChatId: parseInt(senderUid),
                                targetMsgId: result.result.message_id
                            }), {expirationTtl: 172800});
                        }
                    } catch(e) {}
                }
            }

            return new Response('OK');
        }

        if ("/start" === message.text) {
            return new Response('OK');
        }

        const sender = message.chat;
        const senderUid = sender.id.toString();
        const senderName = sender.username ? `@${sender.username}` : [sender.first_name, sender.last_name].filter(Boolean).join(' ');

        const copyMessage = async function (withUrl = false) {
            const ik = [[{
                text: `🔏 From: ${senderName} (${senderUid})`,
                callback_data: senderUid,
            }]];

            if (withUrl) {
                ik[0][0].text = `🔓 From: ${senderName} (${senderUid})`
                ik[0][0].url = `tg://user?id=${senderUid}`;
            }

            return await postToTelegramApi(botToken, 'copyMessage', {
                chat_id: parseInt(ownerUid),
                from_chat_id: message.chat.id,
                message_id: message.message_id,
                reply_markup: {inline_keyboard: ik}
            });
        }

        let response = await copyMessage(true);
        if (!response.ok) {
            response = await copyMessage();
        }

        if (config.MESSAGE_MAP && response.ok) {
            try {
                const result = await response.json();
                if (result.ok && result.result) {
                    await config.MESSAGE_MAP.put(`msg:${senderUid}:${message.message_id}`, JSON.stringify({
                        targetChatId: parseInt(ownerUid),
                        targetMsgId: result.result.message_id
                    }), {expirationTtl: 172800});
                }
            } catch(e) {}
        }

        return new Response('OK');
    } catch (error) {
        console.error('Error handling webhook:', error);
        return new Response('Internal Server Error', {status: 500});
    }
}

export async function handleRequest(request, config) {
    const {prefix, secretToken} = config;

    const url = new URL(request.url);
    const path = url.pathname;

    const INSTALL_PATTERN = new RegExp(`^/${prefix}/install/([^/]+)/([^/]+)$`);
    const UNINSTALL_PATTERN = new RegExp(`^/${prefix}/uninstall/([^/]+)$`);
    const WEBHOOK_PATTERN = new RegExp(`^/${prefix}/webhook/([^/]+)/([^/]+)$`);

    let match;

    if (match = path.match(INSTALL_PATTERN)) {
        return handleInstall(request, match[1], match[2], prefix, secretToken);
    }

    if (match = path.match(UNINSTALL_PATTERN)) {
        return handleUninstall(match[1], secretToken);
    }

    if (match = path.match(WEBHOOK_PATTERN)) {
        return handleWebhook(request, match[1], match[2], config);
    }

    return new Response('Not Found', {status: 404});
}