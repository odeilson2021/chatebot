require('dotenv').config();
const wppconnect = require('@wppconnect-team/wppconnect');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Inicializa o WPPConnect
wppconnect.create({
  session: 'bastos-barbearia',
  catchQR: (base64Qr, asciiQR) => {
    console.log('QR Code gerado, atualizando Supabase...');
    supabase.from('whatsapp_session').upsert({ id: 1, qr_code_data: base64Qr, status: 'connecting' }).then();
  },
  statusFind: (statusSession, session) => {
    console.log('Status da sessão:', statusSession);
    supabase.from('whatsapp_session').upsert({ id: 1, status: statusSession }).then();
  }
}).then((client) => {
  console.log('WhatsApp Conectado!');
  
  // Lógica de recebimento de mensagens
  client.onMessage(async (message) => {
    if (message.isGroupMsg === false) {
      // 1. Busca configurações no Supabase
      const { data: config } = await supabase.from('chatbot_config').select('*').single();
      
      // 2. Responde o cliente
      await client.sendText(message.from, config.greeting_message || 'Olá! Como posso ajudar?');
      
      // 3. Salva no Supabase
      await supabase.from('whatsapp_messages').insert({
        phone_number: message.from,
        message_content: message.body,
        direction: 'inbound'
      });
    }
  });
});

app.listen(process.env.PORT || 3000, () => console.log('Servidor rodando.'));