const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const miniprogramRoot = path.join(root, "miniprogram");
const errors = [];

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

function relative(file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function validateJson(file) {
  try {
    JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    errors.push(`${relative(file)}: JSON 解析失败：${error.message}`);
  }
}

function validateJavaScript(file) {
  try {
    // Parse only. Mini Program globals such as Page and Component do not need to execute.
    new Function(fs.readFileSync(file, "utf8"));
  } catch (error) {
    errors.push(`${relative(file)}: JavaScript 语法错误：${error.message}`);
  }
}

function validateWxss(file) {
  const source = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  let depth = 0;
  for (const character of source) {
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (depth < 0) break;
  }
  if (depth !== 0) {
    errors.push(`${relative(file)}: WXSS 花括号不平衡（${depth}）`);
  }
}

function validateWxml(file) {
  const source = fs.readFileSync(file, "utf8");
  const stack = [];
  const voidTags = new Set(["image", "input", "icon", "progress", "slider", "switch"]);
  const tagPattern = /<\/?([A-Za-z][\w-]*)(?:\s[^<>]*?)?\s*\/?>/g;
  let match;

  while ((match = tagPattern.exec(source))) {
    const raw = match[0];
    const tag = match[1];
    if (raw.startsWith("</")) {
      if (voidTags.has(tag)) continue;
      const openTag = stack.pop();
      if (openTag !== tag) {
        errors.push(`${relative(file)}: 标签不匹配，期望 </${openTag || "无"}>，实际 </${tag}>`);
        return;
      }
    } else if (!raw.endsWith("/>") && !voidTags.has(tag)) {
      stack.push(tag);
    }
  }

  if (stack.length) {
    errors.push(`${relative(file)}: 未闭合标签 <${stack[stack.length - 1]}>`);
  }

  const assetPattern = /(?:src|icon-path|selected-icon-path)=["'](\/[^"']+)["']/g;
  while ((match = assetPattern.exec(source))) {
    const asset = path.join(miniprogramRoot, match[1].replace(/^\//, ""));
    if (!fs.existsSync(asset)) {
      errors.push(`${relative(file)}: 资源不存在 ${match[1]}`);
    }
  }
}

const files = walk(miniprogramRoot);
files.filter((file) => file.endsWith(".json")).forEach(validateJson);
files.filter((file) => file.endsWith(".js")).forEach(validateJavaScript);
files.filter((file) => file.endsWith(".wxss")).forEach(validateWxss);
files.filter((file) => file.endsWith(".wxml")).forEach(validateWxml);

const appConfig = JSON.parse(fs.readFileSync(path.join(miniprogramRoot, "app.json"), "utf8"));
for (const page of appConfig.pages || []) {
  for (const extension of ["js", "json", "wxml", "wxss"]) {
    const pageFile = path.join(miniprogramRoot, `${page}.${extension}`);
    if (!fs.existsSync(pageFile)) {
      errors.push(`app.json: 页面文件不存在 ${relative(pageFile)}`);
    }
  }

  const pageScript = path.join(miniprogramRoot, `${page}.js`);
  const pageTemplate = path.join(miniprogramRoot, `${page}.wxml`);
  if (fs.existsSync(pageScript) && fs.existsSync(pageTemplate)) {
    const scriptSource = fs.readFileSync(pageScript, "utf8");
    const templateSource = fs.readFileSync(pageTemplate, "utf8");
    const eventPattern = /\b(?:bind|catch)(?:tap|input|change|submit|confirm|focus|blur|longpress)=["']([A-Za-z_$][\w$]*)["']/g;
    let eventMatch;
    while ((eventMatch = eventPattern.exec(templateSource))) {
      const handler = eventMatch[1];
      const handlerPattern = new RegExp(`\\b${handler}\\s*\\(`);
      if (!handlerPattern.test(scriptSource)) {
        errors.push(`${page}.wxml: 未在对应脚本中找到事件处理函数 ${handler}`);
      }
    }
  }
}

for (const item of appConfig.tabBar?.list || []) {
  for (const key of ["iconPath", "selectedIconPath"]) {
    const icon = path.join(miniprogramRoot, item[key]);
    if (!fs.existsSync(icon)) {
      errors.push(`app.json: 底部导航资源不存在 ${item[key]}`);
    }
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`UI validation passed: ${files.length} Mini Program files checked.`);
}
