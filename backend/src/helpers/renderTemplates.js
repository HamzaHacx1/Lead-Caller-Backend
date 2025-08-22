const fs = require("fs");
const path = require("path");
const Handlebars = require("handlebars");

function renderTemplate(fileName, data = {}) {
  const filePath = path.join(__dirname, "..", "email-templates", fileName);
  const source = fs.readFileSync(filePath, "utf8");
  const template = Handlebars.compile(source);
  return template(data);
}

module.exports = { renderTemplate };
