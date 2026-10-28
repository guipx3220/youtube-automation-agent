// Language of everything the audience sees or hears: scripts, titles,
// descriptions, tags, narration, and captions. Set CONTENT_LANGUAGE in .env
// to a BCP-47 code such as "pt-BR"; it defaults to English.
const LANGUAGE_NAMES = {
  en: 'English',
  'pt-BR': 'Brazilian Portuguese',
  'pt-PT': 'European Portuguese',
  pt: 'Portuguese',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian'
};

const CAPTION_NAMES = {
  en: 'English Captions',
  'pt-BR': 'Legendas em português',
  'pt-PT': 'Legendas em português',
  pt: 'Legendas em português',
  es: 'Subtítulos en español'
};

function getContentLanguage() {
  const value = String(process.env.CONTENT_LANGUAGE || '').trim();
  return /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value) ? value : 'en';
}

function getContentLanguageName(code = getContentLanguage()) {
  return LANGUAGE_NAMES[code] || LANGUAGE_NAMES[code.split('-')[0]] || code;
}

function getCaptionTrackName(code = getContentLanguage()) {
  return CAPTION_NAMES[code] || CAPTION_NAMES[code.split('-')[0]] || `${getContentLanguageName(code)} captions`;
}

// Extra instruction for the AI text provider. Empty for English so the
// original prompts behave exactly as before.
function getContentLanguageInstruction(code = getContentLanguage()) {
  if (code === 'en') return '';
  const name = getContentLanguageName(code);
  return [
    `Write every piece of audience-facing text in ${name}: video scripts, narration, hooks,`,
    'titles, descriptions, tags, hashtags, chapters, thumbnail text, and topic ideas.',
    'Use natural, idiomatic phrasing for native speakers, not a literal translation.',
    'When the request asks for JSON or another structured format, keep the keys, field names,',
    'and enum values exactly as specified (in English); only the human-readable values change language.'
  ].join(' ');
}

module.exports = {
  getContentLanguage,
  getContentLanguageName,
  getCaptionTrackName,
  getContentLanguageInstruction
};
