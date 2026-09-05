export type Visual = 'rainwater' | 'collection' | 'storage' | 'growth' | 'sun' | 'truck' | 'book' | 'leaf';
export type Scene = {
  id: string;
  title: string;
  text: string;
  visual: Visual;
  primaryVisual?: string;
  duration: number;
  layout: 'centered_illustration_with_heading' | 'illustration_left';
};
export type StudioSettings = {
  color: string;
  paper: string;
  hand: boolean;
  hatching: boolean;
  camera: boolean;
  narration: boolean;
  language: 'en' | 'hi';
  rate: number;
  resolution: '1080' | '720';
};
export type Project = {
  id: string;
  title: string;
  script: string;
  scenes: Scene[];
  settings: StudioSettings;
  updatedAt: number;
};

export const defaultSettings: StudioSettings = {
  color: '#648650', paper: '#fcfbf5', hand: true, hatching: true,
  camera: true, narration: true, language: 'en', rate: 1, resolution: '1080',
};

export function safeSettings(value: unknown): StudioSettings {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const color = (key: string, fallback: string) => typeof data[key] === 'string' && /^#[0-9a-f]{6}$/i.test(data[key] as string) ? data[key] as string : fallback;
  return {
    color: color('color', defaultSettings.color), paper: color('paper', defaultSettings.paper),
    hand: typeof data.hand === 'boolean' ? data.hand : true,
    hatching: typeof data.hatching === 'boolean' ? data.hatching : true,
    camera: typeof data.camera === 'boolean' ? data.camera : true,
    narration: typeof data.narration === 'boolean' ? data.narration : true,
    language: data.language === 'hi' ? 'hi' : 'en',
    resolution: String(data.resolution) === '720' ? '720' : '1080',
    rate: typeof data.rate === 'number' && Number.isFinite(data.rate) && data.rate >= .7 && data.rate <= 1.4 ? data.rate : 1,
  };
}

export const uid = () => globalThis.crypto?.randomUUID?.() ?? `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const initialScript = `Rainwater is a gift. But most of it flows away, unused.

Rainwater harvesting collects and stores this water for the days we need it most.

From rooftops to storage tanks, a simple system makes every drop count.

The result? Greener farms, healthier communities, and a more sustainable tomorrow.`;

const initialTitles = ['Every drop counts.', 'Catch the rain.', 'Save it for later.', 'A greener tomorrow.'];
const initialVisuals: Visual[] = ['rainwater', 'collection', 'storage', 'growth'];

export function newProject(title = 'Untitled story', demo = false): Project {
  return {
    id: uid(), title: demo ? 'Rainwater harvesting' : title,
    script: demo ? initialScript : '',
    scenes: demo ? initialScript.split('\n\n').map((text, i) => ({
      id: uid(), title: initialTitles[i], text, visual: initialVisuals[i],
      duration: [8, 9, 8, 10][i], layout: 'centered_illustration_with_heading',
    })) : [], settings: { ...defaultSettings }, updatedAt: Date.now(),
  };
}

export const visualNames: Record<Visual, string> = {
  rainwater: 'Rain & farmland', collection: 'Rainwater collection', storage: 'Water storage',
  growth: 'Growing together', sun: 'Solar energy', truck: 'Transport & trade',
  book: 'Books & learning', leaf: 'Nature & plants',
};

export function chooseVisual(text: string): Visual {
  if (/storage|tank|reservoir|store|barrel/i.test(text)) return 'storage';
  if (/rooftop|roof|collect|harvest|catch/i.test(text)) return 'collection';
  if (/rain|water|droplet|river|ocean|cloud|khadin/i.test(text)) return 'rainwater';
  if (/farm|crop|grow|community|communities|sustainab|field|food/i.test(text)) return 'growth';
  if (/sun|solar|energy|electric|power/i.test(text)) return 'sun';
  if (/truck|train|vehicle|transport|goods|market|car\b/i.test(text)) return 'truck';
  if (/leaf|plant|tree|nature|photosynthesis|garden/i.test(text)) return 'leaf';
  return 'book';
}

function heading(text: string): string {
  const words = text.replace(/[.!?].*$/, '').split(/\s+/);
  const result = words.slice(0, 6).join(' ');
  return result.length > 48 ? `${result.slice(0, 45)}...` : result;
}

export function parseScript(input: string, mode: 'text' | 'json'): { title?: string; scenes: Scene[]; settings?: StudioSettings } {
  if (!input.trim()) throw new Error('Add a few words to your script first.');
  if (input.length > 30000) throw new Error('Please keep your script under 30,000 characters.');
  if (mode === 'json') {
    let data: { title?: unknown; scenes?: unknown; settings?: unknown };
    try { data = JSON.parse(input); } catch { throw new Error('This JSON needs a little attention. Check the quotes and commas.'); }
    if (!data || !Array.isArray(data.scenes) || data.scenes.length === 0) throw new Error('Add a non-empty "scenes" array to your JSON.');
    if (data.scenes.length > 40) throw new Error('A story can contain up to 40 scenes.');
    const scenes = data.scenes.map((item: unknown, i: number): Scene => {
      if (!item || typeof item !== 'object') throw new Error(`Scene ${i + 1} must be an object.`);
      const row = item as Record<string, unknown>;
      if (typeof row.text !== 'string' || !row.text.trim()) throw new Error(`Scene ${i + 1} needs some narration text.`);
      if (row.text.length > 2000) throw new Error(`Scene ${i + 1} is too long. Keep each scene under 2,000 characters.`);
      const rawKey = row.primary_visual || row.icon || row.visual || '';
      if (typeof rawKey !== 'string' || (rawKey && !/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,99}$/.test(rawKey))) throw new Error(`Scene ${i + 1}: use an illustration name, not a URL or file path.`);
      const key = rawKey;
      if (row.duration != null && typeof row.duration !== 'number') throw new Error(`Scene ${i + 1}: duration must be a number.`);
      if (row.layout != null && !['centered_illustration_with_heading', 'illustration_left'].includes(String(row.layout))) throw new Error(`Scene ${i + 1}: choose a supported scene layout.`);
      const visual = key in visualNames ? key as Visual : chooseVisual(`${key} ${row.text}`);
      const duration = row.duration == null ? Math.max(5, Math.ceil(row.text.split(/\s+/).length / 2.3) + 1) : Number(row.duration);
      if (!Number.isFinite(duration) || duration < 2 || duration > 120) throw new Error(`Scene ${i + 1}: duration must be between 2 and 120 seconds.`);
      return {
        id: uid(), title: typeof row.heading === 'string' ? row.heading.slice(0, 100) : typeof row.title === 'string' ? row.title.slice(0, 100) : heading(row.text),
        text: row.text.trim(), visual, primaryVisual: key || undefined, duration,
        layout: row.layout === 'illustration_left' ? 'illustration_left' : 'centered_illustration_with_heading',
      };
    });
    return { title: typeof data.title === 'string' ? data.title.slice(0, 100) : undefined, scenes, settings: data.settings ? safeSettings(data.settings) : undefined };
  }
  const paragraphs = input.trim().split(/\n\s*\n/).filter(Boolean);
  const chunks = paragraphs.length > 1 ? paragraphs : input.match(/[^.!?\u0964]+(?:[.!?\u0964]+|$)/g) || [input];
  if (chunks.length > 40) throw new Error('Try a shorter script, or group sentences into up to 40 paragraphs.');
  return { scenes: chunks.map(text => {
    text = text.trim();
    if (text.length > 2000) throw new Error('One paragraph is too long. Break it into shorter scenes.');
    return { id: uid(), title: heading(text), text, visual: chooseVisual(text),
      duration: Math.max(5, Math.ceil(text.split(/\s+/).length / 2.3) + 1), layout: 'centered_illustration_with_heading' };
  }) };
}

export function scriptJson(project: Project) {
  return {
    title: project.title,
    settings: project.settings,
    scenes: project.scenes.map(s => ({
      text: s.text, heading: s.title, primary_visual: s.primaryVisual || s.visual,
      layout: s.layout, duration: s.duration,
    })),
  };
}

export const formatTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
export const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'whiteboard-story';

export const templates = [
  { title: 'Every drop counts', category: 'Environment', visual: 'rainwater' as Visual, description: 'A small idea with a lasting impact.', script: initialScript },
  { title: 'A little ray of possibility', category: 'Science', visual: 'sun' as Visual, description: 'Make bright ideas easy to understand.', script: 'The sun gives our planet an incredible amount of energy.\n\nSolar panels capture sunlight and turn it into clean electricity.\n\nThis electricity powers our homes, schools, and communities.\n\nBy choosing renewable energy, we help create a greener tomorrow.' },
  { title: 'From seed to something big', category: 'Education', visual: 'leaf' as Visual, description: 'Help curiosity take root.', script: 'Every great tree begins with a tiny seed.\n\nWith water, sunlight, and a little patience, the seed starts to grow.\n\nIts roots reach into the soil, while its leaves turn sunlight into food.\n\nOver time, one small seed becomes a home for an entire ecosystem.' },
  { title: 'The journey of your coffee', category: 'How it works', visual: 'truck' as Visual, description: 'Connect the dots, one scene at a time.', script: 'Your morning coffee starts on a farm, thousands of miles away.\n\nFarmers carefully harvest and dry each coffee bean.\n\nTrucks transport the beans to local roasters and markets.\n\nFrom the farm to your favorite cup, every step tells a story.' },
];