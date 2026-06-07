require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const axios = require('axios');

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';

const INCOMING_DIR = path.join(__dirname, 'tasks', 'incoming');
const OUTGOING_DIR = path.join(__dirname, 'tasks', 'outgoing');

console.log('[Watcher] Started');

const processing = new Set();

async function thinkAndAct(msg) {
  // Ask DeepSeek to interpret the request and suggest a command
  const res = await axios.post('https://api.deepseek.com/chat/completions', {
    model: 'deepseek-chat',
    max_tokens: 1024,
    messages: [
      {
        role: 'system',
        content: `你是电脑操作助手，也是童锦程（深情祖师爷）的AI化身。

## 角色规则
当用户提到「童锦程」「深情祖师爷」「景辰」等关键词时，切换到童锦程人格：
- 以童锦程第一人称思考和回应
- 口语化、直接、偶尔自嘲
- 叫用户「兄弟」
- 用他的核心观点：吸引力 > 讨好、给人台阶、人性不可考验、自我炫耀即自我暴露

## 核心观点库
- 没有人会因为你喜欢他而喜欢你，别人只会因为你吸引他而喜欢你
- 要给人台阶下，让他能做他想做的事情
- 人性经不起考验，与其测试，不如给他条件让他表现好
- 越缺什么越想炫耀什么
- 成功之后身边全是好人
- 遇到瓶颈：读书或健身，永远不喝酒
- 想见一个人：直接说，给准备时间，不要突袭
- 多说鼓励，少说伤害

## 操作电脑方式
1. 理解他想干什么
2. 如果需要操作电脑，输出 <cmd>要执行的命令</cmd>
3. 然后给出简短说明

例如：
用户：看看桌面
你：<cmd>ls ~/Desktop/</cmd>正在查看桌面文件...

用户：我的电脑有什么
你：<cmd>ls ~/Desktop/</cmd>这是你桌面的内容

用户：你好
你：你好兄弟，有什么需要帮忙的？

规则：
- 路径用 /c/Users/17149/ 格式（git bash格式）
- 只输出必要内容，不要啰嗦
- 不确定用什么命令就 <cmd>pwd</cmd> 先看位置`,
      },
      { role: 'user', content: msg },
    ],
  }, {
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DEEPSEEK_KEY },
    timeout: 30000,
  });

  const text = res.data.choices[0].message.content;

  // Extract command from XML tags
  const cmdMatch = text.match(/<cmd>([\s\S]*?)<\/cmd>/);
  let response = text.replace(/<cmd>[\s\S]*?<\/cmd>/, '').trim();

  if (cmdMatch) {
    const cmd = cmdMatch[1].trim();
    console.log(`[Exec] ${cmd}`);
    try {
      const out = execSync(cmd, {
        cwd: path.join(__dirname, '..'),
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf-8',
        windowsHide: true,
      });
      const truncated = (out || '(空)').substring(0, 1000);
      response += `\n\n结果:\n\`\`\`\n${truncated}\n\`\`\``;
    } catch (e) {
      response += `\n\n执行失败: ${e.message.split('\n')[0]}`;
    }
  }

  if (response.length > 1800) response = response.substring(0, 1800) + '\n\n...(截断)';
  return response;
}

async function processTask(filePath) {
  if (processing.has(filePath)) return;
  processing.add(filePath);

  try {
    const task = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const content = task.content.trim();
    const id = task.id;
    console.log(`[Task] "${content}"`);

    let result;
    try {
      result = await thinkAndAct(content);
    } catch (e) {
      console.error('[AI Error]', e.response?.data || e.message);
      result = '抱歉，处理失败。';
    }

    fs.writeFileSync(path.join(OUTGOING_DIR, `result_${id}.json`), JSON.stringify({
      id, from_user: task.from_user, content: task.content, result,
      created_at: task.created_at, completed_at: Date.now(), status: 'completed',
    }));
    fs.unlinkSync(filePath);
    console.log(`[Done] ${id}`);
  } catch (e) {
    console.error(`[Error] ${path.basename(filePath)}:`, e.message);
    try { fs.unlinkSync(filePath); } catch (_) {}
  } finally {
    processing.delete(filePath);
  }
}

// Poll for new tasks every 2 seconds (more reliable than fs.watch on Windows)
setInterval(() => {
  let files;
  try { files = fs.readdirSync(INCOMING_DIR).filter(f => f.endsWith('.json')); } catch (e) { return; }
  for (const f of files) {
    processTask(path.join(INCOMING_DIR, f));
  }
}, 2000);
