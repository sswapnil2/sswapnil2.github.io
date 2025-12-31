const siteProfile = {
  name: 'Swapnil Sharma',
  tagline: 'Engineer, problem solver, and storyteller based in India.',
  role: 'Software Engineer',
  location: 'Remote · India',
  summary: 'Building reliable products with empathy and precision.',
  mission: 'I design simple, resilient experiences for the web—pairing clean code with thoughtful storytelling.',
  focus: 'Frontend product engineering, content-driven platforms, and mentoring teams through growth.',
  contact: 'hello@swapnilsharma.com'
};

const experienceEntries = [
  {
    title: 'Senior Software Engineer',
    company: 'Product Studio',
    date: '2022 — Present',
    summary: 'Leading the rebuild of a content platform with a modern component system and robust testing.',
    highlights: ['Design systems', 'Type-safe tooling', 'Mentoring']
  },
  {
    title: 'Full-stack Engineer',
    company: 'Growth Startup',
    date: '2019 — 2022',
    summary: 'Shipped customer dashboards, automated deployments, and performance improvements across the stack.',
    highlights: ['React/Next.js', 'Node & APIs', 'CI/CD']
  },
  {
    title: 'Engineer & Writer',
    company: 'Freelance',
    date: '2016 — 2019',
    summary: 'Partnered with founders to build prototypes, landed pages, and blog strategies that convert.',
    highlights: ['Content strategy', 'Rapid prototyping', 'Analytics']
  }
];

const defaultPosts = [
  {
    id: 'default-1',
    title: 'Rewriting my personal site',
    date: '2024-04-05',
    tags: ['personal', 'web'],
    summary: 'Documenting how the new site blends writing and engineering with an editor built into the page.'
  },
  {
    id: 'default-2',
    title: 'Keeping side projects alive',
    date: '2024-03-12',
    tags: ['process', 'product'],
    summary: 'A short checklist I use to keep momentum on personal work while shipping at my day job.'
  }
];

function initProfile() {
  const textBindings = [
    ['[data-name]', 'name'],
    ['[data-tagline]', 'tagline'],
    ['[data-role]', 'role'],
    ['[data-location]', 'location'],
    ['[data-summary]', 'summary'],
    ['[data-mission]', 'mission'],
    ['[data-focus]', 'focus'],
    ['[data-contact]', 'contact']
  ];

  textBindings.forEach(([selector, key]) => {
    document.querySelectorAll(selector).forEach((node) => {
      node.textContent = siteProfile[key];
    });
  });
}

function renderExperience() {
  const timeline = document.getElementById('experience-timeline');
  timeline.innerHTML = '';

  experienceEntries.forEach((entry) => {
    const wrapper = document.createElement('article');
    wrapper.className = 'timeline__item';

    const date = document.createElement('div');
    date.className = 'timeline__date';
    date.textContent = entry.date;

    const body = document.createElement('div');
    const title = document.createElement('h3');
    title.className = 'timeline__title';
    title.textContent = `${entry.title} · ${entry.company}`;

    const meta = document.createElement('div');
    meta.className = 'timeline__meta';
    entry.highlights.forEach((item) => {
      const badge = document.createElement('span');
      badge.className = 'pill';
      badge.textContent = item;
      meta.appendChild(badge);
    });

    const summary = document.createElement('p');
    summary.textContent = entry.summary;

    body.append(title, meta, summary);
    wrapper.append(date, body);
    timeline.appendChild(wrapper);
  });
}

function getStoredPosts() {
  const stored = localStorage.getItem('blogPosts');
  if (!stored) {
    localStorage.setItem('blogPosts', JSON.stringify(defaultPosts));
    return [...defaultPosts];
  }

  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [...defaultPosts];
  } catch (error) {
    return [...defaultPosts];
  }
}

function savePosts(posts) {
  localStorage.setItem('blogPosts', JSON.stringify(posts));
}

function renderPosts(posts) {
  const list = document.getElementById('post-list');
  list.innerHTML = '';

  if (!posts.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No posts yet. Start by adding something that excites you today!';
    list.appendChild(empty);
    return;
  }

  posts
    .slice()
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .forEach((post) => {
      const card = document.createElement('article');
      card.className = 'post-card';

      const header = document.createElement('div');
      header.className = 'post-card__header';

      const titleWrap = document.createElement('div');
      const title = document.createElement('h3');
      title.className = 'post-card__title';
      title.textContent = post.title;
      const date = document.createElement('p');
      date.className = 'post-card__date';
      date.textContent = new Date(post.date).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
      titleWrap.append(title, date);

      const actions = document.createElement('div');
      actions.className = 'post-card__actions';
      const deleteButton = document.createElement('button');
      deleteButton.className = 'post-card__delete';
      deleteButton.type = 'button';
      deleteButton.textContent = 'Delete';
      deleteButton.addEventListener('click', () => deletePost(post.id));
      actions.appendChild(deleteButton);

      header.append(titleWrap, actions);

      const tags = document.createElement('div');
      tags.className = 'post-card__tags';
      post.tags
        .filter(Boolean)
        .forEach((tag) => {
          const chip = document.createElement('span');
          chip.className = 'post-card__tag';
          chip.textContent = tag;
          tags.appendChild(chip);
        });

      const summary = document.createElement('p');
      summary.className = 'post-card__summary';
      summary.textContent = post.summary || 'A new idea waiting to be fleshed out.';

      card.append(header, tags, summary);
      list.appendChild(card);
    });
}

function deletePost(id) {
  const posts = getStoredPosts().filter((post) => post.id !== id);
  savePosts(posts);
  renderPosts(posts);
}

function addPost(form) {
  const formData = new FormData(form);
  const title = (formData.get('title') || '').toString().trim();
  const date = formData.get('date');
  const tags = (formData.get('tags') || '')
    .toString()
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  const summary = (formData.get('summary') || '').toString().trim();

  if (!title || !date) return;

  const newPost = {
    id: crypto.randomUUID ? crypto.randomUUID() : `post-${Date.now()}`,
    title,
    date,
    tags,
    summary
  };

  const next = [newPost, ...getStoredPosts()];
  savePosts(next);
  renderPosts(next);
  form.reset();
}

function wireUpForm() {
  const form = document.getElementById('post-form');
  if (!form) return;

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    addPost(form);
  });
}

function bootstrap() {
  initProfile();
  renderExperience();
  renderPosts(getStoredPosts());
  wireUpForm();
}

document.addEventListener('DOMContentLoaded', bootstrap);
