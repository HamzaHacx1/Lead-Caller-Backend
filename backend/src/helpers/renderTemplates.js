import Handlebars from "handlebars";
import path from "path";
import fs from "fs";

export function renderTemplate(fileName, data = {}) {
  const templateDir =
    process.env.EMAIL_TEMPLATE_DIR ||
    path.join(process.cwd(), "src", "email-templates");
  const filePath = path.join(templateDir, fileName);
  console.debug(`[DEBUG] renderTemplate: Loading template from ${filePath}`);
  try {
    const source = fs.readFileSync(filePath, "utf8");
    const template = Handlebars.compile(source);
    return template(data);
  } catch (error) {
    console.error(
      `[ERROR] renderTemplate: Failed to load ${filePath}: ${error.message}`
    );
    throw error;
  }
}
