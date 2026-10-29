// ==========================================
// BLINDAGEM GLOBAL (Impede que o bot feche por erros inesperados)
// ==========================================
process.on('uncaughtException', (err) => {
    console.error('[ERRO GLOBAL CAPTURADO] O bot resistiu à queda:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[REJEIÇÃO NÃO TRATADA] O bot continuou firme:', reason);
});

// ==========================================
// IMPORTAÇÕES E CONFIGURAÇÃO DO WHATSAPP
// ==========================================
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');

async function connectToWhatsApp() {
    try {
        console.log('[*] A preparar para iniciar a conexão com o WhatsApp...');
        
        // Carrega a sessão (pasta auth_info_baileys)
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            logger: pino({ level: 'fatal' }) // Silencia logs desnecessários para limpar o console
        });

        // Salva as credenciais sempre que houver atualização
        sock.ev.on('creds.update', saveCreds);

        // Monitora o status da conexão
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
                const reason = lastDisconnect?.error?.message;
                
                console.log(`[!] Conexão caiu. Motivo: ${reason || 'Desconhecido'} (Status: ${statusCode})`);
                console.log('[*] Quebrando barreiras... Tentando reconectar o bot imediatamente!');
                
                // Aguarda 3 segundos e reconecta sem desistir nunca
                setTimeout(() => {
                    connectToWhatsApp();
                }, 3000);

            } else if (connection === 'open') {
                console.log('[✓] BOT CONECTADO COM SUCESSO! 100% Online e Operacional.');
            }
        });

        // Ouvinte de mensagens (Insere a tua lógica aqui em baixo)
        sock.ev.on('messages.upsert', async ({ messages }) => {
            const m = messages[0];
            if (!m.message || m.key.fromMe) return;
            
            const messageType = Object.keys(m.message)[0];
            console.log(`[MSG] Mensagem recebida do tipo: ${messageType}`);
            
            // Coloca aqui o teu código de resposta/comandos do bot...
        });

    } catch (error) {
        console.log('[X] Erro crítico na função de conexão, re-tentando em 5 segundos...', error);
        setTimeout(connectToWhatsApp, 5000);
    }
}

// ==========================================
// INICIALIZAÇÃO BLINDADA
// ==========================================
try {
    connectToWhatsApp();
} catch (error) {
    console.log('[X] Erro crítico na inicialização principal, reiniciando...', error);
    setTimeout(connectToWhatsApp, 5000);
}
