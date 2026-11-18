import { createServer } from 'node:http';
import { buildAppFromEnv } from './app.js';
import { resolveConfig } from './config.js';

const config = resolveConfig();
const app = await buildAppFromEnv();
const server = createServer(app);

server.listen(config.port, '0.0.0.0', () => {
  console.log(`DeepSeek 极简聊天已启动：http://0.0.0.0:${config.port}`);
  console.log(`数据目录：${config.dataDir}`);
  console.log(`模型：${config.model}`);
  if (!process.env.APP_SECRET) {
    console.log('提示：未设置 APP_SECRET，已使用数据目录中的自动生成主密钥。');
  }
});

function shutdown(signal) {
  console.log(`收到 ${signal}，正在关闭…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 8_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
