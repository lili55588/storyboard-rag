const fs = require('fs');
const content = fs.readFileSync('src/App.jsx', 'utf8');
let inTemplate = false;
let templateStart = -1;
let templates = [];
for (let i = 0; i < content.length; i++) {
  const char = content[i];
  const prev = i > 0 ? content[i-1] : '';
  if (char === '`' && prev !== '\\') {
    if (!inTemplate) {
      inTemplate = true;
      templateStart = i;
    } else {
      inTemplate = false;
      templates.push({start: templateStart, end: i});
    }
  }
}
console.log('Found template pairs:', templates.length);
let lastEnd = 0;
for (const t of templates) {
  if (lastEnd > 0) {
    const gap = content.substring(lastEnd + 1, t.start);
    const ticksInGap = (gap.match(/`/g) || []).length;
    if (ticksInGap > 0) {
      console.log('UNPAIRED ticks in gap:', ticksInGap);
      console.log('Gap context:', JSON.stringify(gap.substring(0, 200)));
    }
  }
  lastEnd = t.end;
}
