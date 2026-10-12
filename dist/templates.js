/**
 * Board documents use world-space pixels. Objects share { id, type, x, y,
 * width, height, text, color }. Notes can have author and votes (actor → count).
 * Frames use text as their label. Shapes use rectangle, ellipse or diamond.
 * Connectors reference objects using from/to. Images use src; drawings use
 * points: [{ x, y }]. Optional fontSize is a presentation hint.
 */

export const templates = [
  {
    key: 'brainstorm',
    title: 'Brainstorming',
    description: 'Du défi aux idées, puis à l’action.',
    icon: 'sparkles',
    color: '#fff0b5',
  },
  {
    key: 'retro',
    title: 'Rétrospective',
    description: 'Prendre du recul et avancer ensemble.',
    icon: 'rotate-ccw',
    color: '#d9efe3',
  },
  {
    key: 'kanban',
    title: 'Kanban',
    description: 'Une vue claire sur chaque prochaine étape.',
    icon: 'columns-3',
    color: '#dce9ff',
  },
  {
    key: 'blank',
    title: 'Tableau vierge',
    description: 'Un espace libre pour vos grandes idées.',
    icon: 'plus',
    color: '#ece8fa',
  },
];

const COLORS = {
  yellow: '#FFE79A',
  pink: '#F8CDE0',
  green: '#CFECD8',
  blue: '#C9E9F5',
};

function uid(prefix = 'obj') {
  const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${suffix}`;
}

function object(type, x, y, width, height, text = '', color = '#ffffff', extra = {}) {
  return { id: uid(), type, x, y, width, height, text, color, ...extra };
}

function note(x, y, text, color, author, votes = {}) {
  return object('note', x, y, 200, 170, text, color, { author, votes });
}

function heading(text, subtitle, width = 1380) {
  return [
    object('text', 60, 48, width, 55, text, '#252338', { fontSize: 36, fontWeight: 700 }),
    object('text', 62, 116, width, 30, subtitle, '#858293', { fontSize: 17 }),
  ];
}

function brainstorm() {
  return {
    title: 'Un meilleur premier jour',
    description: 'Notre atelier pour imaginer une arrivée simple, humaine et mémorable.',
    objects: [
      ...heading('Un meilleur premier jour ✨', 'Imaginez une arrivée que l’on n’oublie pas. Une idée par note, toutes les voix comptent.'),
      object('frame', 60, 205, 340, 673, '01  Le défi', '#F5F1EA'),
      object('frame', 425, 205, 515, 673, '02  Nos idées', '#F2F0F8'),
      object('frame', 965, 205, 340, 673, '03  Les prochaines étapes', '#EDF4F0'),
      note(126, 294, 'Comment rendre l’arrivée de chaque nouvelle recrue plus simple et mémorable ?', COLORS.yellow, 'ML'),
      note(126, 493, 'Trop d’informations, pas assez de repères. Et si on simplifiait le parcours ?', COLORS.blue, 'AD'),
      note(464, 294, 'Un buddy pour les 30 premiers jours 💛', COLORS.yellow, 'ML', { 'demo-marie': 1, 'demo-alex': 1, 'demo-lea': 1 }),
      note(701, 294, 'Une checklist qui donne envie d’avancer', COLORS.pink, 'AD'),
      note(464, 493, 'Un café d’équipe dès le premier matin ☕', COLORS.green, 'LC'),
      note(701, 493, 'Un petit guide des rituels et des personnes clés', COLORS.blue, 'ML'),
      note(464, 692, 'Un espace pour poser toutes ses questions', COLORS.pink, 'LC'),
      note(1031, 294, 'Tester le parcours avec 3 nouvelles recrues', COLORS.green, 'AD'),
      note(1031, 493, 'Mesurer le ressenti à J+7\nObjectif : 8/10 🎯', COLORS.yellow, 'LC'),
      object('text', 708, 739, 190, 72, 'Et votre prochaine\ngrande idée ?', '#938AA6', { fontSize: 19 }),
      object('text', 1018, 724, 235, 64, 'Choisissons une idée.\nFaisons un premier pas.', '#7C9788', { fontSize: 17 }),
    ],
  };
}

function retro() {
  return {
    title: 'Rétrospective d’équipe',
    description: 'Faire le point sur le dernier cycle et choisir ce qui nous fera progresser.',
    objects: [
      ...heading('On prend du recul 🌿', 'Un temps pour célébrer, apprendre et choisir ensemble nos prochains petits pas.'),
      object('frame', 60, 205, 420, 640, 'Ce qui a bien fonctionné', '#EDF5EF'),
      object('frame', 505, 205, 420, 640, 'Ce qui nous a freinés', '#FAF0F3'),
      object('frame', 950, 205, 420, 640, 'Ce qu’on essaie ensuite', '#EEF2FA'),
      note(100, 296, 'L’entraide a fait toute la différence cette semaine.', COLORS.green, 'ML'),
      note(242, 498, 'Nos points rapides du matin : courts et utiles !', COLORS.yellow, 'AD'),
      note(545, 296, 'Des priorités qui ont changé en cours de route.', COLORS.pink, 'LC'),
      note(687, 498, 'Trop de réunions, peu de temps pour se concentrer.', COLORS.yellow, 'ML'),
      note(990, 296, 'Protéger deux plages de travail sans réunion.', COLORS.blue, 'AD', { 'demo-marie': 1, 'demo-lea': 1 }),
      note(1132, 498, 'Partager une priorité claire chaque lundi.', COLORS.green, 'LC'),
      object('text', 64, 898, 1200, 34, 'Une action concrète, une personne responsable, une date. C’est parti.', '#858293', { fontSize: 18 }),
    ],
  };
}

function kanban() {
  return {
    title: 'Notre projet, pas à pas',
    description: 'Suivre les idées et les tâches, de la première intention au travail terminé.',
    objects: [
      ...heading('Notre projet, pas à pas 🚀', 'Gardez le cap. Déplacez les cartes au rythme de l’équipe.'),
      object('frame', 60, 205, 390, 680, 'À faire', '#F4F2F8'),
      object('frame', 475, 205, 390, 680, 'En cours', '#F9F4E7'),
      object('frame', 890, 205, 390, 680, 'Terminé', '#EEF5EF'),
      note(152, 296, 'Recueillir les retours de l’équipe\n🎤 5 entretiens', COLORS.pink, 'LC'),
      note(152, 498, 'Imaginer le nouveau parcours\n✍️ Atelier jeudi', COLORS.yellow, 'ML'),
      note(152, 700, 'Choisir nos indicateurs de réussite', COLORS.blue, 'AD'),
      note(567, 296, 'Créer le premier prototype\n🛠️ Pour vendredi', COLORS.yellow, 'AD'),
      note(567, 498, 'Préparer le guide de bienvenue', COLORS.blue, 'ML'),
      note(982, 296, 'Définir notre objectif commun\n✅ Validé ensemble', COLORS.green, 'LC'),
      note(982, 498, 'Former le petit groupe de travail', COLORS.green, 'ML'),
    ],
  };
}

export function createTemplate(key = 'brainstorm', title) {
  const builders = { brainstorm, retro, kanban };
  const content = key === 'blank'
    ? { title: 'Mon nouveau tableau', description: 'Un espace libre pour vos idées.', objects: [] }
    : (builders[key] || brainstorm)();
  return {
    id: uid('board'),
    ...content,
    title: typeof title === 'string' && title.trim() ? title.trim() : content.title,
    updatedAt: new Date().toISOString(),
  };
}
