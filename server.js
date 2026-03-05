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
      root: '/'
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

// Middleware para tratamento de erros 404
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Rota não encontrada',
    message: `A rota ${req.originalUrl} não existe`,
    availableEndpoints: ['/health', '/', '/test-supabase']
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

// Função para inicializar o WhatsApp
async function initializeWhatsApp() {
  try {
    console.log('🔄 Iniciando conexão com WhatsApp...');
    
    const client = await wppconnect.create({
      session: 'bastos-barbearia',
      catchQR: async (base64Qr, asciiQR) => {
        console.log('📱 QR Code gerado, atualizando Supabase...');
        try {
          await supabase.from('whatsapp_session').upsert({ 
            id: 1, 
            qr_code_data: base64Qr, 
            status: 'connecting',
            updated_at: new Date().toISOString()
          });
        } catch (error) {
          console.error('❌ Erro ao salvar QR code:', error.message);
        }
      },
      statusFind: async (statusSession, session) => {
        console.log('📊 Status da sessão:', statusSession);
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
    
    // Lógica de recebimento de mensagens com tratamento de erros
    client.onMessage(async (message) => {
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
          await client.sendText(message.from, greetingMessage);
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

    return client;
    
  } catch (error) {
    console.error('❌ Erro ao inicializar WhatsApp:', error.message);
    throw error;
  }
}

// Inicializa o servidor Express
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
  console.log(`📝 Health check disponível em: http://localhost:${PORT}/health`);
  console.log(`🧪 Teste Supabase em: http://localhost:${PORT}/test-supabase`);
});

// Inicializa o WhatsApp após o servidor estar rodando
setTimeout(async () => {
  try {
    await initializeWhatsApp();
  } catch (error) {
    console.error('❌ Falha ao inicializar WhatsApp, mas servidor continua rodando');
  }
}, 2000);

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