import net from "node:net";

function encode(args: string[]) {
  return `*${args.length}\r\n${args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join("")}`;
}

export function redisWindowCount(redisUrl: string, key: string, windowMs: number, now = Date.now()) {
  const slot = Math.floor(now / windowMs);
  const redisKey = `upb:${key}:${slot}`;
  const url = new URL(redisUrl);
  const password = url.password ? decodeURIComponent(url.password) : "";
  const commands = [
    password ? encode(["AUTH", password]) : "",
    encode(["INCR", redisKey]),
    encode(["PEXPIRE", redisKey, String(windowMs)]),
  ].join("");
  return new Promise<number>((resolve, reject) => {
    const socket = net.connect({ host: url.hostname, port: Number(url.port || 6379) });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Redis timed out"));
    }, 1500);
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString();
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("end", () => {
      clearTimeout(timer);
      const numbers = [...buf.matchAll(/:(\d+)\r\n/g)].map((match) => Number(match[1]));
      const count = numbers.find((value) => value > 1) ?? numbers[0];
      resolve(count ?? 0);
    });
    socket.end(commands);
  });
}
