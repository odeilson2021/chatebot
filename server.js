require('dotenv').config();
const wppconnect = require('@wppconnect-team/wppconnect');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const app = express();

// Middleware de segurança e CORS
app.use(helmet({
  contentSecurityPolicy: false, // Desabilitado para permitir scripts externos
  crossOriginEmbedderPolicy: false // Desabilitado para evitar problemas com recursos externos
}));

app.use(cors({
  origin: '*', // Em produção, especifique os domínios permitidos
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Middleware para parsing de JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Verifica se as variáveis de ambiente estão configuradas
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
  console.error('❌ ERRO: SUPABASE_URL e SUPABASE_KEY devem estar configuradas no arquivo .env');
  process.exit(1);
}

let supabase;
try {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  console.log('✅ Supabase conectado com sucesso');
} catch (error) {
  console.error('❌ ERRO ao conectar ao Supabase:', error.message);
  process.exit(1);
}

// Estado global da sessão WhatsApp
let whatsappClient = null;
let sessionStatus = 'disconnected';
let qrCodeData = null;

// Rota de health check para o Render
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Rota raiz para evitar "Cannot GET /"
app.get('/', (req, res) => {
  res.status(200).json({ 
    message: 'WhatsApp Bot API está funcionando!',
    status: 'online',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/health',
      root: '/',
      session: {
        start: '/api/start-session',
        status: '/api/session-status',
        stop: '/api/stop-session'
      }
    }
  });
});

// Rota para testar conexão com Supabase
app.get('/test-supabase', async (req, res) => {
  try {
    const { data, error } = await supabase.from('whatsapp_session').select('*').limit(1);
    if (error) throw error;
    
    res.status(200).json({
      success: true,
      message: 'Conexão com Supabase funcionando',
      data: data
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erro ao conectar com Supabase',
      error: error.message
    });
  }
});

// Rota para iniciar a sessão WhatsApp
app.post('/api/start-session', async (req, res) => {
  try {
    // Verifica se já há uma sessão ativa
    if (whatsappClient && sessionStatus === 'connected') {
      return res.status(400).json({
        success: false,
        message: 'Sessão WhatsApp já está ativa',
        status: sessionStatus
      });
    }

    console.log('🔄 Iniciando nova sessão WhatsApp...');
    sessionStatus = 'connecting';

    // Criar nova sessão
    whatsappClient = await wppconnect.create({
      session: 'bastos-barbearia',
      catchQR: async (base64Qr, asciiQR) => {
        console.log('📱 QR Code gerado');
        qrCodeData = base64Qr;
        sessionStatus = 'qr_ready';
        
        // Salvar QR code no Supabase
        try {
          await supabase.from('whatsapp_session').upsert({ 
            id: 1, 
            qr_code_data: base64Qr, 
            status: 'qr_ready',
            updated_at: new Date().toISOString()
          });
        } catch (error) {
          console.error('❌ Erro ao salvar QR code:', error.message);
        }
      },
      statusFind: async (statusSession, session) => {
        console.log('📊 Status da sessão:', statusSession);
        sessionStatus = statusSession;
        
        // Atualizar status no Supabase
        try {
          await supabase.from('whatsapp_session').upsert({ 
            id: 1, 
            status: statusSession,
            updated_at: new Date().toISOString()
          });
        } catch (error) {
          console.error('❌ Erro ao atualizar status:', error.message);
        }
      },
      // Configurações adicionais para produção
      headless: true,
      devtools: false,
      useChrome: true,
      debug: false,
      logQR: false,
      browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    });

    console.log('✅ WhatsApp conectado com sucesso!');
    sessionStatus = 'connected';

    // Configurar listener de mensagens
    whatsappClient.onMessage(async (message) => {
      if (message.isGroupMsg === false) {
        try {
          console.log(`💬 Mensagem recebida de ${message.from}: ${message.body}`);
          
          // Busca configurações no Supabase
          const { data: config, error: configError } = await supabase
            .from('chatbot_config')
            .select('*')
            .single();
          
          if (configError) {
            console.error('❌ Erro ao buscar configurações:', configError.message);
            return;
          }
          
          // Responde o cliente
          const greetingMessage = config?.greeting_message || 'Olá! Como posso ajudar?';
          await whatsappClient.sendText(message.from, greetingMessage);
          console.log(`📤 Resposta enviada para ${message.from}`);
          
          // Salva mensagem no Supabase
          await supabase.from('whatsapp_messages').insert({
            phone_number: message.from,
            message_content: message.body,
            direction: 'inbound',
            created_at: new Date().toISOString()
          });
          
        } catch (error) {
          console.error('❌ Erro ao processar mensagem:', error.message);
        }
      }
    });

    res.status(200).json({
      success: true,
      message: 'Sessão WhatsApp iniciada com sucesso',
      status: sessionStatus,
      qrCode: qrCodeData
    });

  } catch (error) {
    console.error('❌ Erro ao iniciar sessão:', error.message);
    sessionStatus = 'error';
    
    res.status(500).json({
      success: false,
      message: 'Erro ao iniciar sessão WhatsApp',
      error: error.message,
      status: sessionStatus
    });
  }
});

// Rota para verificar status da sessão
app.get('/api/session-status', (req, res) => {
  res.status(200).json({
    success: true,
    status: sessionStatus,
    hasClient: !!whatsappClient,
    timestamp: new Date().toISOString(),
    qrCode: qrCodeData
  });
});

// Rota para parar a sessão
app.post('/api/stop-session', async (req, res) => {
  try {
    if (!whatsappClient) {
      return res.status(400).json({
        success: false,
        message: 'Nenhuma sessão ativa para parar'
      });
    }

    console.log('🛑 Parando sessão WhatsApp...');
    
    // Fechar conexão
    await whatsappClient.close();
    whatsappClient = null;
    sessionStatus = 'disconnected';
    qrCodeData = null;

    // Atualizar status no Supabase
    try {
      await supabase.from('whatsapp_session').upsert({ 
        id: 1, 
        status: 'disconnected',
        qr_code_data: null,
        updated_at: new Date().toISOString()
      });
    } catch (error) {
      console.error('❌ Erro ao atualizar status no Supabase:', error.message);
    }

    res.status(200).json({
      success: true,
      message: 'Sessão WhatsApp encerrada com sucesso',
      status: sessionStatus
    });

  } catch (error) {
    console.error('❌ Erro ao parar sessão:', error.message);
    
    res.status(500).json({
      success: false,
      message: 'Erro ao parar sessão WhatsApp',
      error: error.message
    });
  }
});

// Middleware para tratamento de erros 404
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Rota não encontrada',
    message: `A rota ${req.originalUrl} não existe`,
    availableEndpoints: [
      '/health',
      '/',
      '/test-supabase',
      '/api/start-session',
      '/api/session-status',
      '/api/stop-session'
    ]
  });
});

// Middleware de tratamento de erros global
app.use((error, req, res, next) => {
  console.error('❌ Erro não tratado:', error);
  res.status(500).json({
    error: 'Erro interno do servidor',
    message: error.message || 'Ocorreu um erro inesperado',
    timestamp: new Date().toISOString()
  });
});

// Inicializa o servidor Express
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📝 Health check disponível em: http://localhost:${PORT}/health`);
  console.log(`🧪 Teste Supabase em: http://localhost:${PORT}/test-supabase`);
  console.log(`📱 Controle de sessão em: http://localhost:${PORT}/api/session-status`);
});

// Tratamento de erros global
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM recebido, encerrando gracefulmente...');
  server.close(() => {
    console.log('✅ Servidor encerrado');
    process.exit(0);
  });
});