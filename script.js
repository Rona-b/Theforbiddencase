"use strict";
// Shared bookshelf rendering, navigation and local reading previews.
const KEYS = { reader: "forbidden-editable-reader-v1" };
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const id = () =>
  globalThis.crypto?.randomUUID?.() ||
  `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clone = (value) => JSON.parse(JSON.stringify(value));
const MONTH_THEMES = [
  ["01-january", "January · Winter & New Year"],
  ["02-february", "February · Valentine’s Day"],
  ["03-march", "March · St. Patrick’s Day"],
  ["04-april", "April · Spring & Easter"],
  ["05-may", "May · Flower garden"],
  ["06-june", "June · Summer solstice"],
  ["07-july", "July · Independence Day"],
  ["08-august", "August · Sunflowers & summer"],
  ["09-september", "September · Harvest & autumn"],
  ["10-october", "October · Halloween"],
  ["11-november", "November · Thanksgiving"],
  ["12-december", "December · Christmas"],
];
function shelfImage(theme = config.theme || "auto", date = new Date()) {
  const name = theme === "auto" ? MONTH_THEMES[date.getMonth()][0] : theme;
  return name === "original"
    ? "images/library-backdrop.png"
    : `images/monthly/${name}.png`;
}
const isText = (value, max = 3000) =>
  typeof value === "string" && value.length <= max;
function safeImage(value) {
  if (!isText(value, 1600000)) return "";
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value))
    return value;
  if (
    /^images\/[a-zA-Z0-9_./-]+\.(png|jpe?g|webp|svg)$/i.test(value) &&
    !value.includes("..")
  )
    return value;
  if (/^https:\/\//.test(value)) {
    try {
      const u = new URL(value);
      return u.protocol === "https:" ? value : "";
    } catch {}
  }
  return "";
}
function safeLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? value : "";
  } catch {
    return "";
  }
}
function validateBook(book, current = false) {
  if (
    !book ||
    !isText(book.id, 100) ||
    !book.id ||
    !isText(book.title, 150) ||
    !book.title.trim() ||
    !isText(book.author, 150) ||
    !book.author.trim() ||
    !isText(book.cover, 1600000)
  )
    throw new Error(
      "Each book needs a title, author, ID, and valid cover setting.",
    );
  if (book.cover && !safeImage(book.cover))
    throw new Error(
      "Use an images/ path, HTTPS image address, or uploaded PNG/JPG/WebP for covers.",
    );
  if (
    current &&
    (!Number.isInteger(book.chapters) ||
      book.chapters < 1 ||
      book.chapters > 1000 ||
      !isText(book.description))
  )
    throw new Error(
      "The current book needs 1–1000 chapters and a description of at most 3,000 characters.",
    );
}
function validateConfig(value) {
  if (
    !value ||
    value.version !== 1 ||
    !isText(value.name, 100) ||
    !value.name.trim() ||
    !isText(value.tagline, 200) ||
    !isText(value.about, 3000)
  )
    throw new Error("This content file has invalid club details.");
  const theme = value.theme || "auto";
  if (!["auto", "original", ...MONTH_THEMES.map((t) => t[0])].includes(theme))
    throw new Error("Choose a valid monthly decoration theme.");
  validateBook(value.current, true);
  if (!Array.isArray(value.upcoming) || value.upcoming.length > 12)
    throw new Error("Add at most 12 upcoming books.");
  value.upcoming.forEach((book) => validateBook(book));
  if (
    new Set(value.upcoming.map((book) => book.id)).size !==
    value.upcoming.length
  )
    throw new Error("Upcoming book IDs must be unique.");
  if (
    !Array.isArray(value.announcements) ||
    value.announcements.length > 20 ||
    value.announcements.some((line) => !isText(line, 500))
  )
    throw new Error(
      "Add at most 20 announcements of up to 500 characters each.",
    );
  if (
    !Array.isArray(value.events) ||
    value.events.length > 20 ||
    value.events.some(
      (event) =>
        !event ||
        !isText(event.id, 100) ||
        !event.id ||
        !isText(event.title, 150) ||
        !event.title.trim() ||
        !isText(event.date, 200) ||
        !isText(event.description, 1500) ||
        !isText(event.link, 500) ||
        (event.link && !safeLink(event.link)),
    )
  )
    throw new Error(
      "Check event details. Meeting links must begin with https://.",
    );
  if (
    new Set(value.events.map((event) => event.id)).size !== value.events.length
  )
    throw new Error("Event IDs must be unique.");
  return clone({ ...value, theme });
}
const base = (() => {
  try {
    return validateConfig(window.CLUB_CONTENT);
  } catch (error) {
    document.querySelector("#localNotice").textContent =
      "Could not load content.js. Keep it beside index.html and check its format. " +
      error.message;
    document.querySelector("#localNotice").classList.add("error");
    throw error;
  }
})();
let config = clone(base);
let storageOK = true;
let startupNotice = "";
function readStorage(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}
function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    storageOK = true;
    return true;
  } catch {
    storageOK = false;
    document.querySelector("#localNotice").textContent =
      "Browser storage is unavailable or full. Download your content before closing this page.";
    toast(
      "Storage is unavailable or full. Download your content to keep your changes.",
    );
    return false;
  }
}
const newReader = () => ({
  profile: { name: "Guest reader", bio: "" },
  progress: {},
  votes: {},
  rsvps: [],
  posts: [],
});
function validateReader(value) {
  if (
    !value ||
    !value.profile ||
    !isText(value.profile.name, 60) ||
    !value.profile.name.trim() ||
    !isText(value.profile.bio, 500) ||
    !value.progress ||
    typeof value.progress !== "object" ||
    Array.isArray(value.progress) ||
    Object.values(value.progress).some(
      (n) => !Number.isInteger(n) || n < 0 || n > 1000,
    ) ||
    !value.votes ||
    typeof value.votes !== "object" ||
    Array.isArray(value.votes) ||
    Object.values(value.votes).some((v) => !isText(v, 100)) ||
    !Array.isArray(value.rsvps) ||
    value.rsvps.some((v) => !isText(v, 100)) ||
    !Array.isArray(value.posts) ||
    value.posts.length > 500
  )
    throw new Error("Invalid reader backup.");
  for (const post of value.posts) {
    if (
      !post ||
      !isText(post.id, 100) ||
      !isText(post.bookId, 100) ||
      !isText(post.bookTitle, 150) ||
      !isText(post.author, 60) ||
      !isText(post.title, 150) ||
      !isText(post.body, 3000) ||
      typeof post.spoiler !== "boolean" ||
      typeof post.liked !== "boolean" ||
      !Number.isFinite(post.created) ||
      !Array.isArray(post.replies) ||
      post.replies.length > 500
    )
      throw new Error("Invalid discussion backup.");
    if (
      post.replies.some(
        (r) => !r || !isText(r.author, 60) || !isText(r.body, 1500),
      )
    )
      throw new Error("Invalid reply backup.");
  }
  return clone(value);
}
let reader = newReader();
try {
  const saved = readStorage(KEYS.reader);
  if (saved) reader = validateReader(saved);
} catch {
  startupNotice = "Invalid saved reader data was skipped.";
}
const room = document.querySelector("#room"),
  roomContent = document.querySelector("#roomContent"),
  roomTitle = document.querySelector("#roomTitle");
let activeRoom = "",
  lastTrigger = null,
  toastTimer;
function toast(message) {
  const el = document.querySelector("#toast");
  el.textContent = message;
  el.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("visible"), 4000);
}
function persistReader(message) {
  const saved = writeStorage(KEYS.reader, reader);
  if (saved && message) toast(message);
}
function cover(book) {
  const image = safeImage(book.cover);
  if (image)
    return `<span class="book-cover actual"><img class="uploaded-cover" src="${esc(image)}" alt="Cover of ${esc(book.title)}"></span>`;
  return `<span class="book-cover"><img class="cover-ornament" src="images/cover-art.svg" alt=""><span class="cover-moon" aria-hidden="true">☾</span><strong>${esc(book.title)}</strong><span>${esc(book.author)}</span></span>`;
}
function renderHome() {
  if (
    !document.querySelector(".library").style.getPropertyValue("--shelf-image")
  )
    document
      .querySelector(".library")
      .style.setProperty("--shelf-image", 'url("images/library-backdrop.png")');
  document.querySelector("#copyrightYear").textContent =
    new Date().getFullYear();
  document.querySelector("#homeEvents").innerHTML =
    config.events
      .map((e) => `<li>${esc(e.title)} — ${esc(e.date)}</li>`)
      .join("") || "<li>No gatherings scheduled.</li>";
  document.title = `${config.name} — Book Club`;
  document.querySelector("#clubName").textContent = config.name;
  document.querySelector("#clubTagline").textContent = config.tagline;
  document.querySelector("#currentTitle").textContent = config.current.title;
  document.querySelector("#currentAuthor").textContent =
    `by ${config.current.author}`;
  document.querySelector("#currentDescription").textContent =
    config.current.description;
  document.querySelector("#currentCover").innerHTML = cover(config.current);
  const chapters = Math.min(
    reader.progress[config.current.id] || 0,
    config.current.chapters,
  );
  document.querySelector("#homeProgress").style.width =
    `${(chapters / config.current.chapters) * 100}%`;
  document.querySelector("#homeProgressLabel").textContent =
    `Your reading: ${chapters} of ${config.current.chapters} chapters`;
  document.querySelector("#announcementList").innerHTML = config.announcements
    .length
    ? config.announcements.map((line) => `<li>${esc(line)}</li>`).join("")
    : "<li>No announcements yet. Make yourself at home.</li>";
  document.querySelector("#upcomingBooks").innerHTML =
    config.upcoming
      .slice(0, 3)
      .map(
        (book) =>
          `<div class="upcoming-item"><button data-room="upcoming" aria-label="Read about ${esc(book.title)}">${cover(book)}</button><h3>${esc(book.title)}</h3><p>${esc(book.author)}</p></div>`,
      )
      .join("") ||
    '<p class="empty">The next adventure is yours to choose. New selections are coming soon.</p>';
}
const titles = {
  current: "Our current read",
  discussions: "The reading room",
  upcoming: "Waiting on the shelf",
  members: "Meet our readers",
  events: "Gather by the lantern",
  tavern: "Welcome to the Tavern",
  about: "About our club",
  vote: "Choose our next adventure",
  art: "Fan art & creations",
  rules: "The club promise",
  profile: "Your reader profile",
  search: "Search the library",
};
function openRoom(name, trigger) {
  if (window.CLUB_PAGE_ROUTES?.[name] && document.body.dataset.page !== name) {
    window.goClubPage(name);
    return;
  }
  if (!titles[name]) return;
  if (!room.open) lastTrigger = trigger || document.activeElement;
  activeRoom = name;
  renderRoom();
  if (!room.open) room.showModal();
}
function renderRoom() {
  roomTitle.textContent = titles[activeRoom];
  roomContent.innerHTML = renderers[activeRoom]();
}
function closeRoom() {
  if (document.body.dataset.page) {
    location.assign("index.html");
    return;
  }
  room.close();
}
function dateLabel(value) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
function renderPosts(query = "", scope = "current") {
  const q = query.toLowerCase();
  const posts = reader.posts.filter(
    (p) =>
      (scope === "all" || p.bookId === config.current.id) &&
      `${p.title} ${p.body}`.toLowerCase().includes(q),
  );
  return posts.length
    ? posts
        .map(
          (post) =>
            `<article class="card"><h3>${esc(post.title)}</h3><p class="meta">${esc(post.author)} · ${esc(post.bookTitle)} · ${esc(dateLabel(post.created))}</p>${post.spoiler ? `<details><summary>Reveal spoiler discussion</summary>${postBody(post)}</details>` : postBody(post)}</article>`,
        )
        .join("")
    : '<p class="empty">No conversations here yet. Start one above.</p>';
}
function postBody(post) {
  return `<p class="post-text">${esc(post.body)}</p><button class="outline" data-like="${esc(post.id)}">${post.liked ? "♥ Liked" : "♡ Like"}</button>${post.replies.map((reply) => `<div class="reply"><p class="meta">${esc(reply.author)}</p><p class="post-text">${esc(reply.body)}</p></div>`).join("")}<form data-reply="${esc(post.id)}"><label for="reply-${esc(post.id)}">Add a reply</label><textarea id="reply-${esc(post.id)}" name="reply" required maxlength="1500"></textarea><div class="actions"><button class="primary">Post reply</button></div></form>`;
}
const renderers = {
  current() {
    const n = Math.min(
      reader.progress[config.current.id] || 0,
      config.current.chapters,
    );
    return `<div class="room-current"><div>${cover(config.current)}</div><div><span class="badge">CURRENT CLUB SELECTION</span><h3>${esc(config.current.title)}</h3><p class="meta">${esc(config.current.author)}</p><p>${esc(config.current.description)}</p></div></div><div class="card"><label for="readingProgress">Your reading progress: <strong id="chapterLabel">${n} / ${config.current.chapters} chapters</strong></label><input id="readingProgress" data-book-id="${esc(config.current.id)}" type="range" min="0" max="${config.current.chapters}" value="${n}"><p class="meta">Progress is stored separately for each book.</p></div><button class="primary" data-room="discussions">Discuss this book</button>`;
  },
  discussions() {
    return `<p>Reading <strong>${esc(config.current.title)}</strong>? Bring your theories and mark your spoilers.</p><p class="notice">Local preview: posts and replies stay in this browser. Other members cannot see them without an online database.</p><form id="postForm" class="card" data-book-id="${esc(config.current.id)}"><label for="postTitle">Conversation title</label><input id="postTitle" name="title" maxlength="150" required><label for="postBody">Your thoughts</label><textarea id="postBody" name="body" maxlength="3000" required></textarea><label class="check-label"><input type="checkbox" name="spoiler">Contains spoilers</label><button class="primary">Post conversation</button></form><div class="field-row"><div><label for="searchPosts">Search discussions</label><input id="searchPosts" type="search"></div><div><label for="postScope">Which books?</label><select id="postScope"><option value="current">Current book</option><option value="all">All books / archive</option></select></div></div><div id="postList">${renderPosts()}</div>`;
  },
  upcoming() {
    return `<p>Our next worlds to explore.</p>${config.upcoming.map((book) => `<article class="card room-current"><div>${cover(book)}</div><div><h3>${esc(book.title)}</h3><p>${esc(book.author)}</p><button class="outline" data-vote="${esc(book.id)}">${reader.votes[config.current.id] === book.id ? "✓ Your choice" : "Choose this book"}</button></div></article>`).join("") || "<p>No upcoming books yet. Add them in content.js.</p>"}`;
  },
  vote() {
    return `<p>Choose the next story calling your name.</p><p class="notice">Your choice is local. This does not tally votes from other devices.</p>${config.upcoming.map((book) => `<article class="card"><h3>${esc(book.title)}</h3><p class="meta">${esc(book.author)}</p><button class="primary" data-vote="${esc(book.id)}">${reader.votes[config.current.id] === book.id ? "✓ Your current choice" : "Choose this book"}</button></article>`).join("") || "<p>No books to vote for yet.</p>"}`;
  },
  events() {
    return `<p>Gather with a good book and your favorite company.</p><p class="notice">RSVPs save locally and do not notify the organizer.</p>${config.events.map((event) => `<article class="card"><h3>${esc(event.title)}</h3><p class="meta">${esc(event.date)}</p><p class="post-text">${esc(event.description)}</p><div class="actions"><button class="outline" data-rsvp="${esc(event.id)}">${reader.rsvps.includes(event.id) ? "✓ Going · Undo RSVP" : "Count me in"}</button>${safeLink(event.link) ? `<a class="primary" href="${esc(safeLink(event.link))}" target="_blank" rel="noopener noreferrer">Open meeting link</a>` : ""}</div></article>`).join("") || "<p>No gatherings announced yet.</p>"}`;
  },
  members() {
    return `<p>There is always room for another reader.</p><article class="card"><h3>${esc(reader.profile.name)}</h3><p class="post-text">${esc(reader.profile.bio || "Your next great adventure is waiting on the shelf.")}</p></article><button class="primary" data-room="profile">Edit your reader card</button><p class="notice">This is your local profile. A shared member directory requires online accounts.</p>`;
  },
  tavern() {
    return `<p>Pull up a chair. Share a theory, say hello, or meet a fellow reader.</p><div class="actions"><button class="primary" data-room="discussions">Open conversations</button><button class="outline" data-room="members">Meet readers</button><button class="outline" data-room="art">Fan art & creations</button></div><p class="notice">This local version does not provide live multi-user chat.</p>`;
  },
  about() {
    return `<p class="post-text">${esc(config.about)}</p><button class="primary" data-room="rules">The club promise</button>`;
  },
  art() {
    return `<p>Share your book-inspired art, playlists, and creations in a conversation. Credit the creator and mark spoilers.</p><button class="primary" data-room="discussions">Share a creation</button>`;
  },
  rules() {
    return `<div class="card"><h3>Make room for every reader</h3><p>Respect different opinions, reading speeds, and personal boundaries.</p><h3>Keep surprises surprising</h3><p>Mark spoilers and mention the chapters you are discussing.</p><h3>Keep the room kind</h3><p>No harassment, personal attacks, or sharing someone else’s private information.</p></div>`;
  },
  profile() {
    return `<form id="profileForm"><label for="readerName">Reader name</label><input id="readerName" name="name" required maxlength="60" value="${esc(reader.profile.name)}"><label for="readerBio">About you</label><textarea id="readerBio" name="bio" maxlength="500">${esc(reader.profile.bio)}</textarea><div class="actions"><button class="primary">Save profile</button></div></form><p class="notice">This profile is local and is not an online sign-in.</p>`;
  },
  search() {
    return `<label for="librarySearch">Search books and rooms</label><input id="librarySearch" type="search" placeholder="Try a book title, events, or discussions"><div id="libraryResults"></div>`;
  },
};
document.addEventListener("click", (event) => {
  const target = event.target.closest("button, a");
  if (!target) return;
  if (target.dataset.room) {
    openRoom(target.dataset.room, target);
    return;
  }
  if (target.dataset.vote) {
    if (!config.upcoming.some((b) => b.id === target.dataset.vote)) return;
    reader.votes[config.current.id] = target.dataset.vote;
    persistReader("Your choice was saved locally.");
    renderRoom();
    return;
  }
  if (target.dataset.rsvp) {
    const e = target.dataset.rsvp;
    reader.rsvps = reader.rsvps.includes(e)
      ? reader.rsvps.filter((n) => n !== e)
      : [...reader.rsvps, e];
    persistReader("Your local RSVP was updated.");
    renderRoom();
    return;
  }
  if (target.dataset.like) {
    const p = reader.posts.find((p) => p.id === target.dataset.like);
    if (p) {
      p.liked = !p.liked;
      persistReader();
      target.textContent = p.liked ? "♥ Liked" : "♡ Like";
    }
    return;
  }
});
document.addEventListener("input", (event) => {
  const el = event.target;
  if (el.id === "readingProgress") {
    reader.progress[config.current.id] = Number(el.value);
    document.querySelector("#chapterLabel").textContent =
      `${el.value} / ${config.current.chapters} chapters`;
    persistReader();
    renderHome();
  }
  if (el.id === "searchPosts") refreshPosts();
  if (el.id === "librarySearch") {
    const q = el.value.trim().toLowerCase();
    const items = [
      ...Object.entries(titles).map(([key, name]) => ({ key, name })),
      { key: "current", name: config.current.title },
      ...config.upcoming.map((b) => ({ key: "upcoming", name: b.title })),
    ];
    document.querySelector("#libraryResults").innerHTML = q
      ? items
          .filter((item) => item.name.toLowerCase().includes(q))
          .map(
            (item) =>
              `<div class="card"><button class="outline" data-room="${item.key}">${esc(item.name)}</button></div>`,
          )
          .join("") || "<p>No results.</p>"
      : "";
  }
});
function refreshPosts() {
  document.querySelector("#postList").innerHTML = renderPosts(
    document.querySelector("#searchPosts").value,
    document.querySelector("#postScope").value,
  );
}
document.addEventListener("change", (event) => {
  if (event.target.id === "postScope") refreshPosts();
});
document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!form.matches("#profileForm,#postForm,[data-reply]")) return;
  event.preventDefault();
  const data = new FormData(form),
    v = (name) => String(data.get(name) || "").trim();
  if (form.id === "profileForm") {
    if (!v("name")) return toast("Enter a reader name.");
    reader.profile = { name: v("name"), bio: v("bio") };
    persistReader("Reader profile saved.");
    renderRoom();
  }
  if (form.id === "postForm") {
    if (!v("title") || !v("body"))
      return toast("Add a title and your thoughts.");
    if (reader.posts.length >= 500)
      return toast(
        "Conversation limit reached. Download a backup before adding more.",
      );
    reader.posts.unshift({
      id: id(),
      bookId: config.current.id,
      bookTitle: config.current.title,
      author: reader.profile.name,
      title: v("title"),
      body: v("body"),
      spoiler: data.has("spoiler"),
      created: Date.now(),
      liked: false,
      replies: [],
    });
    persistReader("Conversation saved locally.");
    renderRoom();
  }
  if (form.dataset.reply) {
    if (!v("reply")) return toast("Write a reply first.");
    const p = reader.posts.find((p) => p.id === form.dataset.reply);
    if (p) {
      if (p.replies.length >= 500) return toast("Reply limit reached.");
      p.replies.push({ author: reader.profile.name, body: v("reply") });
      persistReader("Reply saved locally.");
      refreshPosts();
    }
  }
});
document.addEventListener(
  "error",
  (event) => {
    const image = event.target;
    if (
      image instanceof HTMLImageElement &&
      image.classList.contains("uploaded-cover")
    ) {
      image.closest(".book-cover").outerHTML =
        '<span class="book-cover"><span class="cover-moon">☾</span><strong>Cover unavailable</strong><span>Check the image path in content.js</span></span>';
    }
  },
  true,
);
document.querySelector("#closeRoom").addEventListener("click", closeRoom);
room.addEventListener("close", () => {
  activeRoom = "";
  lastTrigger?.focus();
});
room.addEventListener("click", (event) => {
  if (event.target === room) {
    const r = room.getBoundingClientRect();
    if (
      event.clientX < r.left ||
      event.clientX > r.right ||
      event.clientY < r.top ||
      event.clientY > r.bottom
    )
      closeRoom();
  }
});
renderHome();
if (startupNotice) toast(startupNotice);

// Refresh the decoration if an open page crosses into a new month.

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) setMonthlyArtwork();
});
