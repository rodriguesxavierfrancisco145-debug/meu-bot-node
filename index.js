const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadMediaMessage
} = require('@whisockets/baileys');
const pino = require('pino');
const cron = require('node-cron');
const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');
const express = require('express');

// ==========================================
// SERVIDOR WEB HTTP (ESSENCIAL PARA O RENDER)
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
            console.log(`⚠️ A porta ${PORT} já está em uso. Ignorando conflito.`);
        } else {
            console.error('Erro no servidor HTTP:', e);
        }
    });
}

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

// Ficheiros JSON persistentes
const RANKING_FILE = path.join(__dirname, 'ranking.json');
const COMPROVATIVOS_FILE = path.join(__dirname, 'comprovativos_usados.json');
const COMMANDS_FILE = path.join(__dirname, 'comandos_personalizados.json');

function loadRanking() {
    if (!fs.existsSync(RANKING_FILE)) fs.writeFileSync(RANKING_FILE, JSON.stringify({}));
    try { return JSON.parse(fs.readFileSync(RANKING_FILE)); } catch (e) { return {}; }
}

function saveRanking(data) {
    fs.writeFileSync(RANKING_FILE, JSON.stringify(data, null, 2));
}

function loadComprovativosUsados() {
    if (!fs.existsSync(COMPROVATIVOS_FILE)) fs.writeFileSync(COMPROVATIVOS_FILE, JSON.stringify([]));
    try { return JSON.parse(fs.readFileSync(COMPROVATIVOS_FILE)); } catch (e) { return []; }
}

function saveComprovativoUsado(txId) {
    const usados = loadComprovativosUsados();
    if (!usados.includes(txId)) {
        usados.push(txId);
        fs.writeFileSync(COMPROVATIVOS_FILE, JSON.stringify(usados, null, 2));
    }
}

function loadCustomCommands() {
    if (!fs.existsSync(COMMANDS_FILE)) fs.writeFileSync(COMMANDS_FILE, JSON.stringify({}));
    try { return JSON.parse(fs.readFileSync(COMMANDS_FILE)); } catch (e) { return {}; }
}

function saveCustomCommand(keyword, responseText) {
    const commands = loadCustomCommands();
    commands[keyword.toLowerCase()] = responseText;
    fs.writeFileSync(COMMANDS_FILE, JSON.stringify(commands, null, 2));
}

function parseDataToMB(input) {
    const regex = /^([\d\.,]+)\s*(MB|GB)?$/i;
    const match = input.match(regex);
    if (!match) return 0;
    let value = parseFloat(match[1].replace(',', '.'));
    const unit = (match[2] || 'MB').toUpperCase();
    if (unit === 'GB') value = value * 1024;
    return value;
}

function formatData(totalMB) {
    if (totalMB >= 1024) {
        return `${(totalMB / 1024).toFixed(2).replace('.', ',')} GB`;
    }
    return `${Math.round(totalMB)} MB`;
}

async function isAdmin(sock, chatId, participantJid) {
    try {
        const metadata = await sock.groupMetadata(chatId);
        const participant = metadata.participants.find(p => p.id === participantJid);
        return participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
    } catch (e) {
        return false;
    }
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
        browser: ['Ubuntu', 'Chrome', '22.04.4']
    });

    // GERAÇÃO DO CÓDIGO DE PAREAMENTO PARA O NÚMERO EXATO
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
        }, 5000);
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
                const msgFecho = `🔒🚨 AVISO DO GRUPO 🚨\n\n⚠️ Grupo fechado automaticamente até amanhã! 🔐\n\n🕚 Horário de fecho: 23h ⏰`;
                await sock.sendMessage(targetGroup, { text: msgFecho });
            } catch (err) { console.error('Erro ao fechar grupo:', err); }
        }
    }, { timezone: "Africa/Maputo" });

    cron.schedule('0 8 * * *', async () => {
        const targetGroup = await getTargetGroup(sock);
        if (targetGroup) {
            try {
                await sock.groupSettingUpdate(targetGroup, 'not_announcement');
                const msgAberto = `🔓🔥 GRUPO ABERTO! 🔥\n\n⏰ Horário de abertura: 08h ✅`;
                await sock.sendMessage(targetGroup, { text: msgAberto });
            } catch (err) { console.error('Erro ao abrir grupo:', err); }
        }
    }, { timezone: "Africa/Maputo" });

    // ==========================================
    // INTERCEPTADOR DE MENSAGENS E COMANDOS
    // ==========================================
    sock.ev.on('messages.upsert', async (m) => {
        const mek = m.messages[0];
        if (!mek.message || mek.key.fromMe) return;

        const messageType = Object.keys(mek.message)[0];
        const body = messageType === 'conversation' ? mek.message.conversation :
                     messageType === 'extendedTextMessage' ? mek.message.extendedTextMessage.text :
                     messageType === 'imageMessage' ? mek.message.imageMessage.caption :
                     messageType === 'videoMessage' ? mek.message.videoMessage.caption : '';

        const from = mek.key.remoteJid;
        const sender = mek.key.participant || from;
        const isGroup = from.endsWith('@g.us');
        
        const args = body ? body.trim().split(/ +/) : [];
        const rawCommand = args.length > 0 ? args.shift() : '';
        const command = rawCommand.toLowerCase().replace(/^[.!/]/, '');

        // ANTI-LINK
        if (isGroup && body) {
            const linkRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9][-a-zA-Z0-9]*\.(com|org|net|mz|br|pt|io|me|tk|ml|ga|cf|gq|cc|xyz)(\/[^\s]*)?)/i;
            if (linkRegex.test(body)) {
                if (!(await isAdmin(sock, from, sender))) {
                    try {
                        await sock.sendMessage(from, { delete: { remoteJid: from, id: mek.key.id, participant: sender, fromMe: false } });
                    } catch (e) {}
                    await sock.sendMessage(from, { text: `🚫🔒 Proibido enviar links no grupo, @${sender.split('@')[0]}! ⚠️`, mentions: [sender] }, { quoted: mek });
                    return;
                }
            }
        }

        // COMPROVATIVOS COM TESSERACT OCR
        if (messageType === 'imageMessage' || messageType === 'documentMessage') {
            try {
                const buffer = await downloadMediaMessage(mek, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                const { data: { text } } = await Tesseract.recognize(buffer, 'por');
                const comprovativoDados = processarComprovativo(text);

                if (comprovativoDados.isValido) {
                    const usados = loadComprovativosUsados();
                    if (usados.includes(comprovativoDados.transactionId)) {
                        await sock.sendMessage(from, { text: `⚠️🚫 Este comprovativo já foi utilizado anteriormente!` }, { quoted: mek });
                        return;
                    }
                    saveComprovativoUsado(comprovativoDados.transactionId);
                    await sock.sendMessage(from, { text: `🚨💳 COMPROVATIVO DETECTADO 💳\nID: ${comprovativoDados.transactionId}\nValor: ${comprovativoDados.valor}\nEstado: ⏳ Em verificação` }, { quoted: mek });
                }
            } catch (err) { console.error('Erro OCR:', err); }
        }

        // COMANDOS PERSONALIZADOS
        if (command === 'addcmd') {
            if (isGroup && !(await isAdmin(sock, from, sender))) return;
            const novoComando = args.shift();
            const respostaTexto = args.join(' ');
            if (!novoComando || !respostaTexto) return;
            saveCustomCommand(novoComando, respostaTexto);
            await sock.sendMessage(from, { text: `✅ Comando *${novoComando}* adicionado com sucesso!` }, { quoted: mek });
            return;
        }

        const customCommands = loadCustomCommands();
        if (customCommands[command] || customCommands[rawCommand.toLowerCase()]) {
            const resp = customCommands[command] || customCommands[rawCommand.toLowerCase()];
            await sock.sendMessage(from, { text: resp }, { quoted: mek });
            return;
        }

        switch (command) {
            case 'compra': {
                const quotedContext = mek.message?.extendedTextMessage?.contextInfo;
                if (!quotedContext || !quotedContext.participant || args.length === 0) {
                    await sock.sendMessage(from, { text: '⚠️ Usa: .compra 440MB (respondendo à mensagem do cliente)' }, { quoted: mek });
                    return;
                }
                const clienteJid = quotedContext.participant;
                const clienteNumero = clienteJid.split('@')[0];
                const inputData = args.join('');
                const mbsComprados = parseDataToMB(inputData);
                if (mbsComprados <= 0) return;

                const rankingData = loadRanking();
                if (!rankingData[clienteJid]) {
                    rankingData[clienteJid] = { numero: clienteNumero, totalMB: 0, comprasContador: 0 };
                }
                rankingData[clienteJid].totalMB += mbsComprados;
                rankingData[clienteJid].comprasContador += 1;
                saveRanking(rankingData);

                const sortedRanking = Object.values(rankingData).sort((a, b) => b.totalMB - a.totalMB);
                const posicao = sortedRanking.findIndex(user => user.numero === clienteNumero) + 1;

                await sock.sendMessage(from, { text: `🎉 Compra registada!\nCliente: @${clienteNumero}\nTotal: ${formatData(rankingData[clienteJid].totalMB)}\nPosição: #${posicao}º`, mentions: [clienteJid] }, { quoted: mek });
                break;
            }

            case 'ranking': {
                if (isGroup && !(await isAdmin(sock, from, sender))) return;
                const rankingData = loadRanking();
                const sortedRanking = Object.values(rankingData).sort((a, b) => b.totalMB - a.totalMB);
                if (sortedRanking.length === 0) {
                    await sock.sendMessage(from, { text: '📊 O ranking está vazio!' }, { quoted: mek });
                    return;
                }
                let txt = `🏆👑 RANKING MOZ CONECTED 👑🏆\n\n`;
                const mentions = [];
                sortedRanking.slice(0, 10).forEach((u, i) => {
                    txt += `#${i+1} - @${u.numero} (${formatData(u.totalMB)})\n`;
                    mentions.push(`${u.numero}@s.whatsapp.net`);
                });
                await sock.sendMessage(from, { text: txt, mentions }, { quoted: mek });
                break;
            }

            case 'limpar': {
                if (isGroup && !(await isAdmin(sock, from, sender))) return;
                fs.writeFileSync(RANKING_FILE, JSON.stringify({}));
                await sock.sendMessage(from, { text: '🧹 Ranking limpo com sucesso!' }, { quoted: mek });
                break;
            }

            case 'tabela':
                await sock.sendMessage(from, { text: `🔥📡 TABELA VODACOM 📡🔥\n4MT - 170MB\n7MT - 420MB\n10MT - 600MB\n18MT - 1GB\n100MT - 4.4GB` }, { quoted: mek });
                break;

            case 'pagar':
            case 'pagamento':
                await sock.sendMessage(from, { text: `💳 M-PESA\nNúmero: 84 384 3479\nTitular: Rodrigues` }, { quoted: mek });
                break;
        }
    });
}

function processarComprovativo(rawText) {
    const text = rawText.toUpperCase();
    const temMpesa = text.includes('M-PESA') || text.includes('CONFIRMADO') || text.includes('TRANSFERIDO');
    const temMoeda = text.includes('MT') || text.includes('MZN');
    let transactionId = 'N/A';
    const txMatch = text.match(/CONFIRMADO\s+([A-Z0-9]{10,12})/);
    if (txMatch) transactionId = txMatch[1];

    if (!temMpesa || !temMoeda || transactionId === 'N/A') return { isValido: false };
    
    let valorStr = 'Confirmado';
    const valorMatch = text.match(/([\d\.,]+)\s*(MT|MZN)/);
    if (valorMatch) valorStr = `${valorMatch[1]} MT`;

    return { isValido: true, transactionId, valor: valorStr };
}

async function getTargetGroup(sock) {
    try {
        const groups = await sock.groupFetchAllParticipating();
        const groupIds = Object.keys(groups);
        return groupIds.length > 0 ? groupIds[0] : null;
    } catch (e) { return null; }
}

// INICIAR TUDO DIRETAMENTE NO INDEX.JS
startWebServer();
startBot();
