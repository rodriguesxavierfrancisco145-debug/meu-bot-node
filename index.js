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

// Arquivo JSON para guardar o histórico do ranking
const RANKING_FILE = path.join(__dirname, 'ranking.json');

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

// Função para salvar dados do ranking
function saveRanking(data) {
    fs.writeFileSync(RANKING_FILE, JSON.stringify(data, null, 2));
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

    // Se ainda não estiver registado, gera o código de pareamento automaticamente para os logs do Render com o teu número
    if (!sock.authState.creds.registered) {
        const phoneNumber = "258873361776"; 
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
                const msgFecho = `🔒🚨 **AVISO DO GRUPO** 🚨\n\n⚠️ Grupo fechado automaticamente até amanhã! 🔐\n\n🕚 Horário de fecho: 23h ⏰\n\n✅ O grupo será reaberto amanhã. Obrigado pela compreensão! ❤️👑`;
                await sock.sendMessage(targetGroup, { text: msgFecho });
                console.log('Grupo fechado automaticamente às 23:00');
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
                const msgAberto = `🔓🔥 **GRUPO ABERTO!** 🔥\n\n⏰ Horário de abertura: 08h ✅\n\n💬 Podem voltar a interagir! Respeitem as regras e aproveitem o grupo. ❤️👑`;
                await sock.sendMessage(targetGroup, { text: msgAberto });
                console.log('Grupo aberto automaticamente às 08:00');
            } catch (err) {
                console.error('Erro ao abrir o grupo automaticamente:', err);
            }
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
                     messageType === 'extendedTextMessage' ? mek.message.extendedTextMessage.text : '';

        const from = mek.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        const args = body.trim().split(/ +/);
        const command = args.shift().toLowerCase();

        // ----------------------------------------------------
        // VERIFICAÇÃO DE IMAGEM (COMPROVATIVO)
        // ----------------------------------------------------
        if (messageType === 'imageMessage' || messageType === 'documentMessage') {
            try {
                const buffer = await downloadMediaMessage(
                    mek,
                    'buffer',
                    { },
                    { 
                        logger: pino({ level: 'silent' }),
                        reconnect: async () => true
                    }
                );

                const { data: { text } } = await Tesseract.recognize(buffer, 'por');
                const comprovativoDados = processarComprovativo(text);

                if (comprovativoDados.isValido) {
                    const msgSucesso = `🚨💳 **COMPROVATIVO DETECTADO** 💳🚨\n\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                        `📋 **DETALHES DA TRANSAÇÃO**\n\n` +
                        `👤 **Destinatário:** ${comprovativoDados.destinatario}\n\n` +
                        `📲 **Receptor:** ${comprovativoDados.receptor}\n\n` +
                        `💰 **Valor:** ${comprovativoDados.valor}\n\n` +
                        `🆔 **ID da Transação:** ${comprovativoDados.transactionId}\n\n` +
                        `📅 **Data:** ${comprovativoDados.data}\n\n` +
                        `⏰ **Hora:** ${comprovativoDados.hora}\n\n` +
                        `📌 **Estado:** ⏳ Em verificação\n\n` +
                        `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                        `⚠️ **ATENÇÃO!**\n\n` +
                        `🔎 O comprovativo foi recebido e está a ser analisado para confirmar a autenticidade da transação.\n\n` +
                        `❌ **NÃO CONFIRME O PAGAMENTO ANTES DE VERIFICAR A ENTRADA DO VALOR NA CONTA.**\n\n` +
                        `🛡️ **MOZ CONECTED** 🔥\n` +
                        `💯 Segurança, confiança e transparência! 🚀`;

                    await sock.sendMessage(from, { text: msgSucesso }, { quoted: mek });
                } else {
                    const msgFalso = `🚨❌ **COMPROVATIVO FALSO DETECTADO!** ❌🚨\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `⚠️ Ei, mano! 😤📢\n` +
                        `💳 O teu comprovativo de pagamento não foi confirmado!\n` +
                        `❌ Não tentes enganar o sistema com comprovativos falsos ou editados.\n` +
                        `🔎 Todos os pagamentos são verificados antes da confirmação.\n` +
                        `🚫 PAGAMENTO NÃO CONFIRMADO = SERVIÇO NÃO DISPONIBILIZADO!\n` +
                        `━━━━━━━━━━━━━━━━━━\n` +
                        `🔐 MOZ CONECTED 🔥\n` +
                        `✅ Segurança • Confiança • Transparência`;

                    await sock.sendMessage(from, { text: msgFalso }, { quoted: mek });
                }
            } catch (err) {
                console.error('Erro ao processar imagem:', err);
            }
        }

        switch (command) {
            // ----------------------------------------------------
            // ADICIONAR COMPRA E ATUALIZAR RANKING
            // ----------------------------------------------------
            case '.compra':
            case 'compra':
            case '!compra': {
                const quotedContext = mek.message?.extendedTextMessage?.contextInfo;
                if (!quotedContext || !quotedContext.participant) {
                    await sock.sendMessage(from, { 
                        text: '⚠️ **Atenção:** Responde à mensagem do cliente com o comando!\nExemplo: `.compra 440MB` ou `.compra 1.5GB`' 
                    }, { quoted: mek });
                    return;
                }

                if (args.length === 0) {
                    await sock.sendMessage(from, { 
                        text: '⚠️ Informa a quantidade comprada.\nExemplo: `.compra 440MB` ou `.compra 1GB`' 
                    }, { quoted: mek });
                    return;
                }

                const clienteJid = quotedContext.participant;
                const clienteNumero = clienteJid.split('@')[0];
                const inputData = args.join('');
                const mbsComprados = parseDataToMB(inputData);

                if (mbsComprados <= 0) {
                    await sock.sendMessage(from, { 
                        text: '❌ Formato inválido! Usa valores como: `440MB`, `1GB`, `770MB` ou `2GB`.' 
                    }, { quoted: mek });
                    return;
                }

                const rankingData = loadRanking();

                if (!rankingData[clienteJid]) {
                    rankingData[clienteJid] = {
                        numero: clienteNumero,
                        totalMB: 0,
                        comprasContador: 0
                    };
                }

                rankingData[clienteJid].totalMB += mbsComprados;
                rankingData[clienteJid].comprasContador += 1;
                saveRanking(rankingData);

                const sortedRanking = Object.values(rankingData).sort((a, b) => b.totalMB - a.totalMB);
                const posicao = sortedRanking.findIndex(user => user.numero === clienteNumero) + 1;
                const totalFormatado = formatData(rankingData[clienteJid].totalMB);

                const msgCompra = `🎉 **COMPRA REGISTADA COM SUCESSO!** 🚀\n\n` +
                    `👤 **Cliente:** @${clienteNumero}\n` +
                    `📦 **Compra Atual:** ${inputData.toUpperCase()}\n` +
                    `💾 **Total Acumulado:** ${totalFormatado}\n` +
                    `🏆 **Posição no Ranking:** #${posicao}º lugar\n\n` +
                    `👑 Obrigado por preferir a **MOZ CONECTED**! 🔥`;

                await sock.sendMessage(from, { 
                    text: msgCompra,
                    mentions: [clienteJid]
                }, { quoted: mek });
                break;
            }

            // ----------------------------------------------------
            // CONSULTAR TOP 10 RANKING
            // ----------------------------------------------------
            case '.ranking':
            case 'ranking':
            case '!ranking': {
                const rankingData = loadRanking();
                const sortedRanking = Object.values(rankingData).sort((a, b) => b.totalMB - a.totalMB);

                if (sortedRanking.length === 0) {
                    await sock.sendMessage(from, { text: '📊 O ranking ainda está vazio!' });
                    return;
                }

                let rankingTxt = `🏆👑 **RANKING DE CLIENTES - MOZ CONECTED** 👑🏆\n\n` +
                                 `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

                const mentions = [];
                const topList = sortedRanking.slice(0, 10);

                topList.forEach((user, index) => {
                    let medalha = '👤';
                    if (index === 0) medalha = '🥇';
                    else if (index === 1) medalha = '🥈';
                    else if (index === 2) medalha = '🥉';

                    rankingTxt += `${medalha} **#${index + 1}** - @${user.numero}\n` +
                                  `   └ 💾 Total: **${formatData(user.totalMB)}**\n\n`;

                    mentions.push(`${user.numero}@s.whatsapp.net`);
                });

                rankingTxt += `━━━━━━━━━━━━━━━━━━━━━━\n` +
                              `🔥 Continua a comprar para subir no ranking e ter acesso a ofertas exclusivas! 🚀`;

                await sock.sendMessage(from, { text: rankingTxt, mentions });
                break;
            }

            case 'tabela':
            case '!tabela':
                const tabelaTexto = `🔥📡 **MOZ CONECTED** 📡🔥\n\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `📶 **TABELA OFICIAL DE PREÇOS**\n` +
                    `🇲🇿 **INTERNET VODACOM** 🇲🇿\n` +
                    `━━━━━━━━━━━━━━━━━━\n\n` +
                    `💥 **PREÇOS QUE CABEM NO SEU BOLSO!** 💥\n\n` +
                    `🚀 Internet rápida, segura e estável para estares sempre conectado!\n\n` +
                    `📦 **PACOTES DIÁRIOS**\n` +
                    `🎯 **OFERTAS ESPECIAIS**\n\n` +
                    `💰 **4MT**  — 130MB\n` +
                    `💰 **7MT**  — 360MB\n` +
                    `💰 **10MT** — 440MB\n` +
                    `💰 **15MT** — 580MB\n` +
                    `💰 **18MT** — 770MB\n` +
                    `💰 **24MT** — 1GB\n` +
                    `💰 **48MT** — 2GB\n` +
                    `💰 **75MT** — 3GB\n` +
                    `💰 **100MT** — 4GB\n` +
                    `💰 **125MT** — 5GB\n\n` +
                    `━━━━━━━━━━━━━━━━━━\n` +
                    `🔥 **MOZ CONECTED** 🔥\n` +
                    `📲 Mais internet, menos gastos!\n` +
                    `💯 Qualidade e preços acessíveis para todos!\n\n` +
                    `📡 A tua conexão, a nossa prioridade! ❤️‍🔥`;
                
                await sock.sendMessage(from, { text: tabelaTexto });
                break;

            case 'pagar':
            case 'pagamento':
            case '!pagamento':
                const pagamentoTexto = `💳🔥 **FORMAS DE PAGAMENTO** 🔥💳\n\n` +
                    `━━━━━━━━━━━━━━━━━━\n\n` +
                    `📱 **M-PESA**\n\n` +
                    `💰 **Número:** 84 384 3479\n` +
                    `👤 **Nome:** Rodrigues\n\n` +
                    `━━━━━━━━━━━━━━━━━━\n\n` +
                    `✅ **PAGAMENTO FÁCIL, RÁPIDO E SEGURO!** 🚀\n\n` +
                    `⚠️ **ATENÇÃO, CLIENTES!**\n\n` +
                    `📌 Após realizar o pagamento, envie o comprovativo de pagamento para confirmar a sua transação. 🧾✅\n\n` +
                    `⚠️ **MÉTODOS DE PAGAMENTO DISPONÍVEIS**\n\n` +
                    `📲 Neste momento, aceitamos pagamentos somente via M-Pesa.\n\n` +
                    `🔜 Em breve, teremos também e-Mola, para facilitar ainda mais os vossos pagamentos!\n\n` +
                    `🙏 Obrigado pela preferência e pela confiança! ❤️🔥\n\n` +
                    `💯 **A SUA SATISFAÇÃO É A NOSSA PRIORIDADE!** 🚀`;

                await sock.sendMessage(from, { text: pagamentoTexto });
                break;

            case 'grupo':
                if (!isGroup) {
                    await sock.sendMessage(from, { text: '❌ Este comando só pode ser usado dentro de grupos!' });
                    return;
                }
                
                const action = args[0] ? args[0].toLowerCase() : '';
                
                if (action === 'f') {
                    try {
                        await sock.groupSettingUpdate(from, 'announcement');
                        await sock.sendMessage(from, { text: '🔒 **Grupo fechado manualmente!** 🔐' });
                    } catch (e) {
                        await sock.sendMessage(from, { text: '❌ Erro: Certifica-te de que o bot é administrador do grupo.' });
                    }
                } else if (action === 'a') {
                    try {
                        await sock.groupSettingUpdate(from, 'not_announcement');
                        await sock.sendMessage(from, { text: '🔓 **Grupo aberto manualmente!** ✅' });
                    } catch (e) {
                        await sock.sendMessage(from, { text: '❌ Erro: Certifica-te de que o bot é administrador do grupo.' });
                    }
                }
                break;
        }
    });
}

function processarComprovativo(rawText) {
    const text = rawText.toUpperCase();

    const temMpesa = text.includes('M-PESA') || text.includes('CONFIRMADO') || text.includes('TRANSFERIDO') || text.includes('PAGO');
    const temMoeda = text.includes('MT') || text.includes('MZN');

    const transactionMatch = text.match(/([A-Z0-9]{10,12})/);
    const valorMatch = text.match(/(\d+[\.,]?\d*)\s*(MT|MZN)/);
    const dataMatch = text.match(/(\d{2}[\/\.-]\d{2}[\/\.-]\d{2,4})/);
    const horaMatch = text.match(/(\d{2}:\d{2}(:\d{2})?)/);

    if (!temMpesa || !temMoeda || !transactionMatch) {
        return { isValido: false };
    }

    let destinatario = 'Cliente M-Pesa';
    let receptor = 'Rodrigues';

    const rodMatch = text.match(/(RODRIGUES[A-Z\s]*)/);
    if (rodMatch) receptor = rodMatch[0].trim();

    return {
        isValido: true,
        transactionId: transactionMatch ? transactionMatch[1] : 'N/A',
        valor: valorMatch ? `${valorMatch[1]} MT` : 'Confirmado',
        data: dataMatch ? dataMatch[1] : new Date().toLocaleDateString('pt-PT'),
        hora: horaMatch ? horaMatch[1] : new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }),
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
        console.error('Erro ao buscar grupos:', e);
        return null;
    }
}

startBot();
