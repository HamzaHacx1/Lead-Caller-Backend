import Handlebars from "handlebars";
import path from "path";
import fs from "fs";

export function renderTemplate(fileName, data = {}) {
  const filePath = path.join(process.cwd(), "src", "email-templates", fileName);
  const source = fs.readFileSync(filePath, "utf8");
  const template = Handlebars.compile(source);
  return template(data);
}
