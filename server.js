// ==========================================
// BLINDAGEM GLOBAL (Impede qualquer crash)
// ==========================================
process.on('uncaughtException', (err) => {
    console.error('[ERRO GLOBAL CAPTURADO] O bot resistiu à queda:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[REJEIÇÃO NÃO TRATADA] O bot continuou firme:', reason);
});

// ==========================================
// IMPORTAÇÕES E CONFIGURAÇÕES
// ==========================================
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');

// Configura o servidor Express para o Render manter a porta aberta
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Bot Moz com Pairing Code direto ativo e operacional!');
});

app.listen(PORT, () => {
    console.log(`[EXPRESS] Servidor web a escutar na porta ${PORT}`);
});

// ==========================================
// CONEXÃO WHATSAPP COM PAIRING CODE AUTOMÁTICO
// ==========================================
async function connectToWhatsApp() {
    try {
        console.log('[*] A iniciar sessão do WhatsApp...');
        
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

        const sock = makeWASocket({
            auth: state,
            browser: Browsers.macOS('Desktop'),
            logger: pino({ level: 'fatal' })
        });

        sock.ev.on('creds.update', saveCreds);

        // SE NÃO ESTIVER AUTENTICADO, GERA O CÓDIGO COM O NÚMERO DIRETO
        if (!sock.authState.creds.registered) {
            const phoneNumber = "258853673680"; 
            
            console.log(`\n📱 A solicitar código de pareamento para o número: ${phoneNumber}`);
            
            // Dá um pequeno tempo para o socket inicializar com estabilidade
            setTimeout(async () => {
                try {
                    let code = await sock.requestPairingCode(phoneNumber);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    console.log('\n========================================');
                    console.log(`🔑 TEU CÓDIGO DE PAREAMENTO: ${code}`);
                    console.log('========================================\n');
                } catch (err) {
                    console.error('[X] Erro ao gerar código de pareamento:', err);
                }
            }, 5000);
        }

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
                const reason = lastDisconnect?.error?.message;
                
                console.log(`[!] Conexão fechada. Motivo: ${reason || 'Desconhecido'} (Status: ${statusCode})`);
                console.log('[*] Quebrando barreiras... A reiniciar o ciclo de conexão agora!');
                
                setTimeout(() => {
                    connectToWhatsApp();
                }, 3000);

            } else if (connection === 'open') {
                console.log('[✓] BOT CONECTADO COM SUCESSO VIA CÓDIGO DE PAREAMENTO! 100% Online.');
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            const m = messages[0];
            if (!m.message || m.key.fromMe) return;
            
            const messageType = Object.keys(m.message)[0];
            console.log(`[MSG] Mensagem recebida: ${messageType}`);
        });

    } catch (error) {
        console.log('[X] Erro crítico na conexão, re-tentando em 5 segundos...', error);
        setTimeout(connectToWhatsApp, 5000);
    }
}

// Inicialização principal blindada
try {
    connectToWhatsApp();
} catch (error) {
    console.log('[X] Erro fatal no arranque, reiniciando...', error);
    setTimeout(connectToWhatsApp, 5000);
}
