import { extractActivateLink } from "../services/qwen-email-verify.ts";

const sample = `Activate My Account
[https://chat.qwen.ai/api/v1/auths/activate?id=28d0ffc9-dd7f-4e6e-a09f-dca7b57a2a0c&token=2ec043e99561bf4e3593cd6678ff9e03bff2af6cfdaf306736d07e1d14c23a74]`;

console.log("text:", extractActivateLink(sample));

const html = `href="https://chat.qwen.ai/api/v1/auths/activate?id=28d0ffc9-dd7f-4e6e-a09f-dca7b57a2a0c\\u0026token=abc123def456"`;
console.log("html:", extractActivateLink(html));
