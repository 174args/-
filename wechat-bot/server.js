require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs');
const path = require('path');

// ============ Configuration ============
const config = {
  corpId: process.env.WECOM_CORP_ID || '',
  agentSecret: process.env.WECOM_AGENT_SECRET || '',
  token: process.env.WECOM_TOKEN || '',
  encodingAESKey: process.env.WECOM_ENCODING_AES_KEY || '',
  agentId: process.env.WECOM_AGENT_ID || '',
  port: process.env.PORT || 3000,
};

const TASKS_DIR = path.join(__dirname, 'tasks');
const INCOMING_DIR = path.join(TASKS_DIR, 'incoming');
const OUTGOING_DIR = path.join(TASKS_DIR, 'outgoing');

// Ensure task directories exist
fs.mkdirSync(INCOMING_DIR, { recursive: true });
fs.mkdirSync(OUTGOING_DIR, { recursive: true });

// ============ WeChat Work Crypto ============
class MsgCrypt {
  constructor(token, encodingAESKey, corpId) {
    this.token = token;
    this.corpId = corpId;
    this.aesKey = Buffer.from(encodingAESKey + '=', 'base64');
    this.iv = this.aesKey.subarray(0, 16);
  }

  decrypt(encryptedBase64) {
    const decipher = crypto.createDecipheriv('aes-256-cbc', this.aesKey, this.iv);
    decipher.setAutoPadding(false);
    let decrypted = Buffer.concat([decipher.update(encryptedBase64, 'base64'), decipher.final()]);

    const pad = decrypted[decrypted.length - 1];
    if (pad <= 0 || pad > 32) throw new Error('Invalid padding');
    decrypted = decrypted.subarray(0, decrypted.length - pad);

    const msgLen = decrypted.readUInt32BE(16);
    const xml = decrypted.subarray(20, 20 + msgLen).toString('utf-8');
    const corpid = decrypted.subarray(20 + msgLen).toString('utf-8');

    if (corpid !== this.corpId) throw new Error('CorpID mismatch');
    return xml;
  }

  encrypt(xml) {
    const random = crypto.randomBytes(16);
    const xmlBuf = Buffer.from(xml, 'utf-8');
    const msgLenBuf = Buffer.alloc(4);
    msgLenBuf.writeUInt32BE(xmlBuf.length);
    const corpidBuf = Buffer.from(this.corpId, 'utf-8');
    const plain = Buffer.concat([random, msgLenBuf, xmlBuf, corpidBuf]);

    const blockSize = 32;
    const padLen = blockSize - (plain.length % blockSize);
    const padded = Buffer.concat([plain, Buffer.alloc(padLen, padLen)]);

    const cipher = crypto.createCipheriv('aes-256-cbc', this.aesKey, this.iv);
    return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
  }

  sign(timestamp, nonce, encrypted) {
    const arr = [this.token, timestamp, nonce, encrypted].sort();
    return crypto.createHash('sha1').update(arr.join('')).digest('hex');
  }

  verify(signature, timestamp, nonce, encrypted) {
    return this.sign(timestamp, nonce, encrypted) === signature;
  }
}

// ============ Main App ============
const app = express();
const parser = new xml2js.Parser({ explicitArray: false, trim: true });
const builder = new xml2js.Builder({ rootName: 'xml', headless: true, cdata: true });

let msgCrypt;
let accessToken = '';
let tokenExpiresAt = 0;

function getMsgCrypt() {
  if (!msgCrypt) {
    msgCrypt = new MsgCrypt(config.token, config.encodingAESKey, config.corpId);
  }
  return msgCrypt;
}

app.use('/callback', express.raw({ type: 'text/xml' }));

app.get('/', (req, res) => res.send('WeChat Claude Bot running'));

// ============ Callback: URL Verification (GET) ============
app.get('/callback', (req, res) => {
  const { msg_signature, timestamp, nonce, echostr } = req.query;
  const mc = getMsgCrypt();

  if (!mc.verify(msg_signature, timestamp, nonce, echostr)) {
    return res.status(403).send('Signature verification failed');
  }

  try {
    const decryptedEchostr = mc.decrypt(echostr);
    res.send(decryptedEchostr);
  } catch (err) {
    res.status(400).send('Decrypt failed');
  }
});

// ============ Callback: Receive Messages (POST) ============
app.post('/callback', async (req, res) => {
  const { msg_signature, timestamp, nonce } = req.query;
  const mc = getMsgCrypt();

  const encryptedXml = req.body.toString('utf-8');
  let encryptedMsg;
  try {
    const parsed = await parser.parseStringPromise(encryptedXml);
    encryptedMsg = parsed.xml.Encrypt;
  } catch (e) {
    return res.status(400).send('XML parse error');
  }

  if (!mc.verify(msg_signature, timestamp, nonce, encryptedMsg)) {
    return res.status(403).send('Signature verification failed');
  }

  let decryptedXml;
  try {
    decryptedXml = mc.decrypt(encryptedMsg);
  } catch (e) {
    return res.status(400).send('Decrypt failed');
  }

  let msg;
  try {
    msg = (await parser.parseStringPromise(decryptedXml)).xml;
  } catch (e) {
    return res.status(400).send('Message parse error');
  }

  console.log(`[Message] From: ${msg.FromUserName}, Content: ${msg.Content}`);

  // Sync reply: acknowledge immediately
  const emptyReply = '<xml><ToUserName><![CDATA[' + msg.FromUserName + ']]></ToUserName>' +
    '<FromUserName><![CDATA[' + msg.ToUserName + ']]></FromUserName>' +
    '<CreateTime>' + Math.floor(Date.now() / 1000) + '</CreateTime>' +
    '<MsgType><![CDATA[text]]></MsgType>' +
    '<Content><![CDATA[]]></Content></xml>';

  const encryptXml = mc.encrypt(emptyReply);
  const responseSignature = mc.sign(timestamp, nonce, encryptXml);
  const replyXml = builder.buildObject({
    xml: {
      Encrypt: encryptXml,
      MsgSignature: responseSignature,
      TimeStamp: timestamp,
      Nonce: nonce,
    }
  });

  res.type('text/xml').send(replyXml);

  // Save as task instead of calling DeepSeek
  saveTask(msg).catch(err => console.error('[Save Task Error]', err.message));
});

// ============ Task Queue ============
async function saveTask(msg) {
  if (msg.MsgType !== 'text') return;

  const task = {
    id: msg.MsgId || Date.now().toString(),
    from_user: msg.FromUserName,
    content: msg.Content.trim(),
    created_at: Date.now(),
    status: 'pending',
  };

  const filePath = path.join(INCOMING_DIR, `task_${task.id}.json`);
  // Avoid overwriting if same MsgId
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
    console.log(`[Task Saved] ${filePath}`);
  }
}

// Poll for outgoing results and send to WeChat
async function pollOutgoing() {
  try {
    const files = fs.readdirSync(OUTGOING_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(OUTGOING_DIR, file);
      try {
        const result = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (result.status === 'completed') {
          console.log(`[Sending Result] To: ${result.from_user}`);
          await sendWeChatMessage(result.from_user, result.result);
          fs.unlinkSync(filePath);
          console.log(`[Result Sent] ${file}`);
        }
      } catch (e) {
        // If file is being written, skip
        if (e.code !== 'ENOENT') {
          console.error(`[Poll Error] ${file}:`, e.message);
        }
      }
    }
  } catch (e) {
    // Directory might not exist
  }
}

// Poll every 3 seconds
setInterval(pollOutgoing, 3000);

// ============ WeChat API ============
async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken;

  const res = await axios.get('https://qyapi.weixin.qq.com/cgi-bin/gettoken', {
    params: { corpid: config.corpId, corpsecret: config.agentSecret },
  });

  if (res.data.errcode !== 0) throw new Error('Get token failed: ' + res.data.errmsg);

  accessToken = res.data.access_token;
  tokenExpiresAt = Date.now() + (res.data.expires_in - 60) * 1000;
  return accessToken;
}

async function sendWeChatMessage(userId, content) {
  try {
    const token = await getAccessToken();
    await axios.post(
      'https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=' + token,
      {
        touser: userId,
        msgtype: 'text',
        agentid: config.agentId,
        text: { content },
      }
    );
    console.log(`[WeChat Sent] To: ${userId}`);
  } catch (err) {
    console.error('[Send Message Error]', err.response?.data || err.message);
  }
}

// ============ Start Server ============
app.listen(config.port, () => {
  console.log(`WeChat Bot running on port ${config.port}`);
  console.log(`Task queue: ${TASKS_DIR}`);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
