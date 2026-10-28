const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const cron = require('node-cron');
const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');
const express = require('express');

// Limpar a pasta de sessão antiga no arranque para forçar um código novo válido
const authFolder = path.join(__dirname, 'auth_info');
if (!global.sock_startup_cleaned && fs.existsSync(authFolder)) {
    try {
        fs.rmSync(authFolder, { recursive: true, force: true });
        console.log('🧹 Sessão anterior limpa com sucesso para gerar um código fresco!');
    } catch (e) {
        console.log('⚠️ Aviso ao limpar sessão:', e);
    }
}
global.sock_startup_cleaned = true;

// Ficheiro JSON para guardar o histórico do ranking (persistente)
const RANKING_FILE = path.join(__dirname, 'ranking.json');

// Ficheiro JSON para guardar os comprovativos já utilizados
const COMPROVATIVOS_FILE = path.join(__dirname, 'comprovativos_usados.json');

// Ficheiro JSON para guardar os comandos adicionados dinamicamente via WhatsApp
const COMMANDS_FILE = path.join(__dirname, 'comandos_personalizados.json');

// Função para carregar dados do ranking
function loadRanking() {
    if (!fs.existsSync(RANKING_FILE)) {
        fs.writeFileSync(RANKING_FILE, JSON.stringify({}));
    }
    try {
        const data = fs.readFileSync(RANKING_FILE);
        return JSON.parse(data);
    } catch (e) {
        return {};
    }
}

// Função para salvar dados do ranking permanentemente
function saveRanking(data) {
    fs.writeFileSync(RANKING_FILE, JSON.stringify(data, null, 2));
}

// Função para carregar comprovativos usados
function loadComprovativosUsados() {
    if (!fs.existsSync(COMPROVATIVOS_FILE)) {
        fs.writeFileSync(COMPROVATIVOS_FILE, JSON.stringify([]));
    }
    try {
        const data = fs.readFileSync(COMPROVATIVOS_FILE);
        return JSON.parse(data);
    } catch (e) {
        return [];
    }
}

// Função para salvar comprovativo usado
function saveComprovativoUsado(txId) {
    const usados = loadComprovativosUsados();
    if (!usados.includes(txId)) {
        usados.push(txId);
        fs.writeFileSync(COMPROVATIVOS_FILE, JSON.stringify(usados, null, 2));
    }
}

// Função para carregar comandos personalizados
function loadCustomCommands() {
    if (!fs.existsSync(COMMANDS_FILE)) {
        fs.writeFileSync(COMMANDS_FILE, JSON.stringify({}));
    }
    try {
        const data = fs.readFileSync(COMMANDS_FILE);
        return JSON.parse(data);
    } catch (e) {
        return {};
    }
}

// Função para salvar um novo comando permanentemente
function saveCustomCommand(keyword, responseText) {
    const commands = loadCustomCommands();
    commands[keyword.toLowerCase()] = responseText;
    fs.writeFileSync(COMMANDS_FILE, JSON.stringify(commands, null, 2));
}

// Auxiliar para converter texto em MB (ex: "440MB" -> 440, "1.5GB" -> 1536)
function parseDataToMB(input) {
    const regex = /^([\d\.,]+)\s*(MB|GB)?$/i;
    const match = input.match(regex);
    if (!match) return 0;

    let value = parseFloat(match[1].replace(',', '.'));
    const unit = (match[2] || 'MB').toUpperCase();

    if (unit === 'GB') {
        value = value * 1024;
    }
    return value;
}

// Auxiliar para formatar MBs acumulados em formato legível (MB / GB)
function formatData(totalMB) {
    if (totalMB >= 1024) {
        const gb = (totalMB / 1024).toFixed(2);
        return `${gb.replace('.', ',')} GB`;
    }
    return `${Math.round(totalMB)} MB`;
}

// Auxiliar para verificar se o remetente é administrador do grupo
async function isAdmin(sock, chatId, participantJid) {
    try {
        const metadata = await sock.groupMetadata(chatId);
        const participant = metadata.participants.find(p => p.id === participantJid);
        return participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
    } catch (e) {
        return false;
    }
}

// ==========================================
// SERVIDOR WEB HTTP (CORRIGIDO CONTRA EADDRINUSE)
// ==========================================
function startWebServer() {
    const app = express();
    const PORT = process.env.PORT || 10000;

    app.get('/', (req, res) => {
        res.send('🔥 MOZ CONECTED BOT ESTÁ ONLINE 24H! 🚀');
    });

    const server = app.listen(PORT, () => {
        console.log(`🌐 Servidor HTTP ativo e escutando na porta ${PORT}`);
    });

    server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
            console.log(`⚠️ A porta ${PORT} já está em uso. Ignorando conflito para evitar crash.`);
        } else {
            console.error('Erro no servidor HTTP:', e);
        }
    });
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
        },
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '22.04.4'],
        markOnlineOnConnect: true,
        fireInitQueries: false,
        generateHighQualityLinkPreview: false
    });

    if (!sock.authState.creds.registered) {
        const phoneNumber = "258853673680"; 
        setTimeout(async () => {
            try {
                console.log('\n📱 A solicitar código de pareamento para o número:', phoneNumber);
                let code = await sock.requestPairingCode(phoneNumber);
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                console.log(`\n========================================`);
                console.log(`🔥 O TEU CÓDIGO DE PAREAMENTO É: ${code}`);
                console.log(`========================================\n`);
            } catch (err) {
                console.error('❌ Erro ao gerar o código de pareamento:', err);
            }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão fechada. A reconectar...', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('\n🔥 MOZ CONECTED BOT LIGADO COM SUCESSO! 🚀\n');
        }
    });

    // ==========================================
    // AGENDAMENTOS AUTOMÁTICOS (CRON)
    // ==========================================

    cron.schedule('0 23 * * *', async () => {
        const targetGroup = await getTargetGroup(sock);
        if (targetGroup) {
            try {
                await sock.groupSettingUpdate(targetGroup, 'announcement');
                const msgFecho = `🔒🚨 AVISO DO GRUPO 🚨\n\n⚠️ Grupo fechado automaticamente até amanhã! 🔐\n\n🕚 Horário de fecho: 23h ⏰\n\n✅ O grupo será reaberto amanhã. Obrigado pela compreensão! ❤️👑`;
                await sock.sendMessage(targetGroup, { text: msgFecho });
            } catch (err) {
                console.error('Erro ao fechar o grupo automaticamente:', err);
            }
        }
    }, { timezone: "Africa/Maputo" });

    cron.schedule('0 8 * * *', async () => {
        const targetGroup = await getTargetGroup(sock);
        if (targetGroup) {
            try {
                await sock.groupSettingUpdate(targetGroup, 'not_announcement');
                const msgAberto = `🔓🔥 GRUPO ABERTO! 🔥\n\n⏰ Horário de abertura: 08h ✅\n\n💬 Podem voltar a interagir! Respeitem as regras e aproveitem o grupo. ❤️👑`;
                await sock.sendMessage(targetGroup, { text: msgAberto });
            } catch (err) {
                console.error('Erro ao abrir o grupo automaticamente:', err);
            }
        }
    }, { timezone: "Africa/Maputo" });

    // ==========================================
    // INTERCEPTADOR DE MENSAGENS E COMANDOS (OTIMIZADO PARA VELOCIDADE)
    // ==========================================
    sock.ev.on('messages.upsert', async (m) => {
        const mek = m.messages[0];
        if (!mek.message || mek.key.fromMe) return;

        const messageType = Object.keys(mek.message)[0];
        const body = messageType === 'conversation' ? mek.message.conversation :
                     messageType === 'extendedTextMessage' ? mek.message.extendedTextMessage.text : '';

        const from = mek.key.remoteJid;
        const sender = mek.key.participant || from;
        const isGroup = from.endsWith('@g.us');
        const args = body.trim().split(/ +/);
        const command = args.length > 0 ? args.shift().toLowerCase() : '';

        // ----------------------------------------------------
        // COMANDOS PERSONALIZADOS (RESPOSTA INSTANTÂNEA)
        // ----------------------------------------------------
        const customCommands = loadCustomCommands();
        const fullCommandWithPrefix = `.${command}`;
        const exactCommandWithExclamation = `!${command}`;
        
        if (customCommands[command]) {
            await sock.sendMessage(from, { text: customCommands[command] }, { quoted: mek });
            return;
        } else if (customCommands[fullCommandWithPrefix]) {
            await sock.sendMessage(from, { text: customCommands[fullCommandWithPrefix] }, { quoted: mek });
            return;
        } else if (customCommands[exactCommandWithExclamation]) {
            await sock.sendMessage(from, { text: customCommands[exactCommandWithExclamation] }, { quoted: mek });
            return;
        }

        // ----------------------------------------------------
        // DETECTOR E BLOQUEIO DE LINKS EM GRUPOS
        // ----------------------------------------------------
        if (isGroup && body) {
            const linkRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9][-a-zA-Z0-9]*\.(com|org|net|mz|br|pt|io|me|tk|ml|ga|cf|gq|cc|xyz)(\/[^\s]*)?)/i;
            
            if (linkRegex.test(body)) {
                const userIsAdmin = await isAdmin(sock, from, sender);
                if (!userIsAdmin) {
                    try {
                        await sock.sendMessage(from, {
                            delete: {
                                remoteJid: from,
                                id: mek.key.id,
                                participant: sender,
                                fromMe: false
                            }
                        });
                    } catch (e) {}

                    const msgAntiLink = `🚫🔒 AVISO IMPORTANTE — MOZ CONECTED 🔒🚫\n\n` +
                        `⚠️ É ESTRITAMENTE PROIBIDO ENVIAR LINKS NO GRUPO! 🚫🔗\n\n` +
                        `❌ Não envie links de outros grupos ou sites sem autorização.\n` +
                        `📢 O incumprimento poderá resultar na expulsão! ⚠️`;

                    await sock.sendMessage(from, { text: msgAntiLink }, { quoted: mek });
                    return;
                }
            }
        }

        // ----------------------------------------------------
        // VERIFICAÇÃO DE COMPROVATIVO (IMAGEM, DOCUMENTO OU TEXTO)
        // ----------------------------------------------------
        if (messageType === 'imageMessage' || messageType === 'documentMessage') {
            try {
                const buffer = await downloadMediaMessage(mek, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                const { data: { text } } = await Tesseract.recognize(buffer, 'por');
                const comprovativoDados = processarComprovativo(text);

                if (comprovativoDados.isValido) {
                    const usados = loadComprovativosUsados();
                    if (usados.includes(comprovativoDados.transactionId)) {
                        await sock.sendMessage(from, { text: `⚠️🚫 COMPROVATIVO JÁ UTILIZADO 🚫⚠️\n\n❌ Este comprovativo já foi utilizado anteriormente no sistema!` }, { quoted: mek });
                        return;
                    }

                    saveComprovativoUsado(comprovativoDados.transactionId);

                    const msgSucesso = `🚨💳 COMPROVATIVO DETECTADO 💳🚨\n\n` +
                        `👤 Destinatário: ${comprovativoDados.destinatario}\n` +
                        `📲 Receptor: ${comprovativoDados.receptor}\n` +
                        `💰 Valor: ${comprovativoDados.valor}\n` +
                        `🆔 ID: ${comprovativoDados.transactionId}\n` +
                        `📅 Data: ${comprovativoDados.data} - ${comprovativoDados.hora}\n` +
                        `📌 Estado: ⏳ Em verificação\n\n` +
                        `⚠️ NÃO CONFIRME O PAGAMENTO ANTES DE VERIFICAR A ENTRADA NA CONTA!`;

                    await sock.sendMessage(from, { text: msgSucesso }, { quoted: mek });
                } else {
                    await sock.sendMessage(from, { text: `🚨❌ COMPROVATIVO FALSO OU INVÁLIDO! ❌🚨` }, { quoted: mek });
                }
            } catch (err) {}
        } else if (body && (body.toUpperCase().includes('CONFIRMADO') || body.toUpperCase().includes('RECEBESTE'))) {
            const comprovativoDados = processarComprovativo(body);

            if (comprovativoDados.isValido) {
                const usados = loadComprovativosUsados();
                if (usados.includes(comprovativoDados.transactionId)) {
                    await sock.sendMessage(from, { text: `⚠️🚫 COMPROVATIVO JÁ UTILIZADO 🚫⚠️` }, { quoted: mek });
                    return;
                }

                saveComprovativoUsado(comprovativoDados.transactionId);

                const msgSucesso = `🚨💳 COMPROVATIVO DETECTADO 💳🚨\n\n` +
                    `👤 Destinatário: ${comprovativoDados.destinatario}\n` +
                    `📲 Receptor: ${comprovativoDados.receptor}\n` +
                    `💰 Valor: ${comprovativoDados.valor}\n` +
                    `🆔 ID: ${comprovativoDados.transactionId}\n` +
                    `📌 Estado: ⏳ Em verificação\n\n` +
                    `⚠️ NÃO CONFIRME O PAGAMENTO ANTES DE VERIFICAR A ENTRADA NA CONTA!`;

                await sock.sendMessage(from, { text: msgSucesso }, { quoted: mek });
            }
        }

        // ----------------------------------------------------
        // ADICIONAR COMANDOS DIRETAMENTE VIA WHATSAPP
        // ----------------------------------------------------
        if (command === '.addcmd' || command === '!addcmd' || command === 'addcmd') {
            if (isGroup && !(await isAdmin(sock, from, sender))) {
                await sock.sendMessage(from, { text: '❌ Apenas administradores podem adicionar novos comandos!' }, { quoted: mek });
                return;
            }

            const novoComando = args.shift();
            const respostaTexto = args.join(' ');

            if (!novoComando || !respostaTexto) {
                await sock.sendMessage(from, { text: '⚠️ Uso incorreto!\nExemplo: !addcmd !regras Respeitem todos.' }, { quoted: mek });
                return;
            }

            saveCustomCommand(novoComando, respostaTexto);
            await sock.sendMessage(from, { text: `✅ Comando *${novoComando}* adicionado com sucesso! 🚀` }, { quoted: mek });
            return;
        }

        switch (command) {
            case '.compra':
            case 'compra':
            case '!compra': {
                const quotedContext = mek.message?.extendedTextMessage?.contextInfo;
                if (!quotedContext || !quotedContext.participant) {
                    await sock.sendMessage(from, { text: '⚠️ Responde à mensagem do cliente com o comando!\nExemplo: .compra 440MB' }, { quoted: mek });
                    return;
                }

                if (args.length === 0) {
                    await sock.sendMessage(from, { text: '⚠️ Informa a quantidade. Ex: .compra 440MB' }, { quoted: mek });
                    return;
                }

                const clienteJid = quotedContext.participant;
                const clienteNumero = clienteJid.split('@')[0];
                const inputData = args.join('');
                const mbsComprados = parseDataToMB(inputData);

                if (mbsComprados <= 0) {
                    await sock.sendMessage(from, { text: '❌ Formato inválido! Usa ex: 440MB, 1GB.' }, { quoted: mek });
                    return;
                }

                const rankingData = loadRanking();
                if (!rankingData[clienteJid]) {
                    rankingData[clienteJid] = { numero: clienteNumero, totalMB: 0, comprasContador: 0 };
                }

                rankingData[clienteJid].totalMB += mbsComprados;
                rankingData[clienteJid].comprasContador += 1;
                saveRanking(rankingData);

                const sortedRanking = Object.values(rankingData).sort((a, b) => b.totalMB - a.totalMB);
                const posicao = sortedRanking.findIndex(user => user.numero === clienteNumero) + 1;
                const totalFormatado = formatData(rankingData[clienteJid].totalMB);

                const msgCompra = `🎉 COMPRA REGISTADA! 🚀\n\n` +
                    `👤 Cliente: @${clienteNumero}\n` +
                    `📦 Compra: ${inputData.toUpperCase()}\n` +
                    `💾 Total: ${totalFormatado}\n` +
                    `🏆 Ranking: #${posicao}º lugar\n\n` +
                    `👑 MOZ CONECTED! 🔥`;

                await sock.sendMessage(from, { text: msgCompra, mentions: [clienteJid] }, { quoted: mek });
                break;
            }

            case '.ranking':
            case 'ranking':
            case '!ranking': {
                const rankingData = loadRanking();
                const sortedRanking = Object.values(rankingData).sort((a, b) => b.totalMB - a.totalMB);

                if (sortedRanking.length === 0) {
                    await sock.sendMessage(from, { text: '📊 O ranking ainda está vazio!' }, { quoted: mek });
                    return;
                }

                let rankingTxt = `🏆👑 RANKING DE CLIENTES - MOZ CONECTED 👑🏆\n\n`;
                const mentions = [];
                const topList = sortedRanking.slice(0, 10);

                topList.forEach((user, index) => {
                    let medalha = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '👤';
                    rankingTxt += `${medalha} #${index + 1} - @${user.numero}\n   └ 💾 Total: ${formatData(user.totalMB)}\n\n`;
                    mentions.push(`${user.numero}@s.whatsapp.net`);
                });

                await sock.sendMessage(from, { text: rankingTxt, mentions }, { quoted: mek });
                break;
            }

            case 'tabela':
            case '!tabela':
                const tabelaTexto = `🔥📡 MOZ CONECTED 📡🔥\n\n` +
                    `📶 TABELA OFICIAL DE PREÇOS\n` +
                    `🇲🇿 INTERNET VODACOM 🇲🇿\n\n` +
                    `💰 4MT  — 130MB\n` +
                    `💰 7MT  — 360MB\n` +
                    `💰 10MT — 440MB\n` +
                    `💰 15MT — 580MB\n` +
                    `💰 18MT — 770MB\n` +
                    `💰 24MT — 1GB\n` +
                    `💰 48MT — 2GB\n` +
                    `💰 75MT — 3GB\n` +
                    `💰 100MT — 4GB\n` +
                    `💰 125MT — 5GB\n\n` +
                    `🔥 MOZ CONECTED — Mais internet, menos gastos! 🚀`;
                await sock.sendMessage(from, { text: tabelaTexto }, { quoted: mek });
                break;

            case 'pagar':
            case 'pagamento':
            case '!pagamento':
                const pagamentoTexto = `💳🔥 FORMAS DE PAGAMENTO 🔥💳\n\n` +
                    `📱 M-PESA\n` +
                    `💰 Número: 84 384 3479\n` +
                    `👤 Titular: Rodrigues\n\n` +
                    `⚠️ Envie o comprovativo após o pagamento. 🧾✅`;
                await sock.sendMessage(from, { text: pagamentoTexto }, { quoted: mek });
                break;

            case 'grupo':
                if (!isGroup) return;
                if (!(await isAdmin(sock, from, sender))) {
                    await sock.sendMessage(from, { text: '❌ Apenas administradores!' }, { quoted: mek });
                    return;
                }
                
                const action = args[0] ? args[0].toLowerCase() : '';
                if (action === 'f') {
                    await sock.groupSettingUpdate(from, 'announcement');
                    await sock.sendMessage(from, { text: '🔒 Grupo fechado manualmente! 🔐' }, { quoted: mek });
                } else if (action === 'a') {
                    await sock.groupSettingUpdate(from, 'not_announcement');
                    await sock.sendMessage(from, { text: '🔓 Grupo aberto manualmente! ✅' }, { quoted: mek });
                }
                break;
        }
    });
}

function processarComprovativo(rawText) {
    const text = rawText.toUpperCase();
    const temMpesa = text.includes('M-PESA') || text.includes('CONFIRMADO') || text.includes('TRANSFERIDO') || text.includes('PAGO') || text.includes('RECEBESTE');
    const temMoeda = text.includes('MT') || text.includes('MZN');

    let transactionId = 'N/A';
    const txMatch = text.match(/CONFIRMADO\s+([A-Z0-9]{10,12})/);
    if (txMatch) {
        transactionId = txMatch[1];
    } else {
        const fallbackTx = text.match(/([A-Z0-9]{10,12})/);
        if (fallbackTx) transactionId = fallbackTx[1];
    }

    let valorStr = 'Confirmado';
    const valorMatch = text.match(/([\d\.,]+)\s*(MT|MZN)/);
    if (valorMatch) valorStr = `${valorMatch[1]} MT`;

    const dataMatch = text.match(/(\d{2}[\/\.-]\d{2}[\/\.-]\d{2,4})/);
    let horaStr = new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit', hour12: false });
    const horaMatch = text.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
    if (horaMatch) {
        let rawHora = horaMatch[1].trim().toUpperCase();
        if (rawHora.includes('PM')) {
            let partes = rawHora.replace('PM', '').trim().split(':');
            let h = parseInt(partes[0]) + (parseInt(partes[0]) < 12 ? 12 : 0);
            horaStr = `${h}:${partes[1]}`;
        } else if (rawHora.includes('AM')) {
            let partes = rawHora.replace('AM', '').trim().split(':');
            let h = parseInt(partes[0]) === 12 ? 0 : parseInt(partes[0]);
            horaStr = `${h < 10 ? '0' + h : h}:${partes[1]}`;
        } else {
            horaStr = rawHora;
        }
    }

    if (!temMpesa || !temMoeda || transactionId === 'N/A') {
        return { isValido: false };
    }

    let destinatario = 'Cliente M-Pesa';
    const deMatch = text.match(/(?:DE|PARA)\s+([0-9\s\-]+[\–\-]?[A-Z\s]+)/);
    if (deMatch) destinatario = deMatch[1].trim();

    let receptor = 'Rodrigues';
    const rodMatch = text.match(/(RODRIGUES[A-Z\s]*)/);
    if (rodMatch) receptor = rodMatch[0].trim();

    return {
        isValido: true,
        transactionId: transactionId,
        valor: valorStr,
        data: dataMatch ? dataMatch[1] : new Date().toLocaleDateString('pt-PT'),
        hora: horaStr,
        destinatario: destinatario,
        receptor: receptor
    };
}

async function getTargetGroup(sock) {
    try {
        const groups = await sock.groupFetchAllParticipating();
        const groupIds = Object.keys(groups);
        return groupIds.length > 0 ? groupIds[0] : null;
    } catch (e) {
        return null;
    }
}

// Iniciar Servidor Web & Bot otimizado
startWebServer();
startBot();
