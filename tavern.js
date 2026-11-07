"use strict";
const $ = (s) => document.querySelector(s),
  feed = $("#feed");
let session = null,
  next = null,
  busy = false,
  loaded = new Set(),
  previewURL = null,
  pendingMedia = null,
  pagingInitialized = false;
$("#year").textContent = new Date().getFullYear();
async function api(path, method = "GET", body) {
  const r = await fetch("/api/" + path, {
    method,
    credentials: "same-origin",
    headers:
      method === "GET"
        ? {}
        : {
            "Content-Type": "application/json",
            "X-CSRF-Token": session?.csrf || "",
          },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || "Please try again.");
  return d;
}
function node(tag, text, cls) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
}
function linked(el, text) {
  const re = /https?:\/\/[^\s<>]+/g;
  let start = 0;
  for (const m of text.matchAll(re)) {
    el.append(document.createTextNode(text.slice(start, m.index)));
    const a = node("a", m[0]);
    a.href = m[0];
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    el.append(a);
    start = m.index + m[0].length;
  }
  el.append(document.createTextNode(text.slice(start)));
}
function media(parent, m) {
  if (!m || !/^\/media\/[a-f0-9]{32}$/.test(m.url)) return;
  const el = document.createElement(
    m.mime.startsWith("video/") ? "video" : "img",
  );
  el.src = m.url;
  el.className = "art-media";
  if (el.tagName === "VIDEO") {
    el.controls = true;
    el.playsInline = true;
    el.preload = "metadata";
  } else {
    el.alt = "Artwork shared by a club member";
    el.loading = "lazy";
  }
  parent.append(el);
}
function deleteButton(parent, label, path, done) {
  const b = node("button", label, "remove");
  b.type = "button";
  b.onclick = async () => {
    if (!confirm("Remove this contribution?")) return;
    b.disabled = true;
    try {
      await api(path, "DELETE", {});
      done();
    } catch (e) {
      $("#status").textContent = e.message;
      b.disabled = false;
    }
  };
  parent.append(b);
}
const revealed = new Set();
function spoilerBox(parent, key, spoiler) {
  if (!spoiler) return parent;
  const d = node("details", undefined, "spoiler");
  d.open = revealed.has(key);
  d.append(node("summary", "⚠ Spoiler alert — select to reveal"));
  d.addEventListener("toggle", () => {
    if (d.open) revealed.add(key);
    else revealed.delete(key);
  });
  parent.append(d);
  return d;
}
function reactionButtons(target, kind, id) {
  target.replaceChildren();
  for (const emoji of ["❤️", "😂", "📚", "✨", "👍"]) {
    const item = target.reactionData?.find((r) => r.emoji === emoji),
      b = node("button", emoji + " " + (item?.count || 0), "reaction");
    b.type = "button";
    b.setAttribute("aria-label", "React " + emoji);
    b.setAttribute("aria-pressed", String(!!item?.mine));
    b.onclick = async () => {
      b.disabled = true;
      try {
        await api("tavern-reactions/" + kind + "/" + id, "POST", { emoji });
        await refreshPost(target.closest("[data-post]").dataset.post);
      } catch (e) {
        $("#status").textContent = e.message;
      } finally {
        b.disabled = false;
      }
    };
    target.append(b);
  }
}
function commentsFor(post, holder) {
  holder.replaceChildren(node("strong", post.comments.length + " replies"));
  for (const c of post.comments) {
    const box = node("div", undefined, "comment");
    box.append(node("strong", c.name));
    const content = spoilerBox(box, "comment-" + c.id, c.spoiler);
    const body = node("p");
    linked(body, c.body);
    content.append(body);
    box.append(node("time", new Date(c.created).toLocaleString(), "timestamp"));
    const reactions = node("div", undefined, "reactions");
    reactions.reactionData = c.reactions;
    reactionButtons(reactions, "comment", c.id);
    content.append(reactions);
    if (c.canDelete)
      deleteButton(box, "Remove reply", "tavern-comments/" + c.id, () =>
        refreshPost(post.id),
      );
    holder.append(box);
  }
}
function postCard(p) {
  const card = node("article", undefined, "panel");
  card.dataset.post = p.id;
  const head = node("header", undefined, "post-head"),
    person = node("div");
  person.append(
    node("strong", p.name),
    node("time", new Date(p.created).toLocaleString(), "timestamp"),
  );
  head.append(node("span", p.name.slice(0, 1).toUpperCase(), "avatar"), person);
  card.append(head);
  const content = spoilerBox(card, "post-" + p.id, p.spoiler),
    body = node("p", undefined, "post-body");
  linked(body, p.body);
  content.append(body);
  media(content, p.media);
  if (p.canDelete)
    deleteButton(card, "Remove post", "chat/" + p.id, () => {
      card.remove();
      loaded.delete(p.id);
      refresh();
    });
  const reactions = node("div", undefined, "post-reactions reactions");
  reactions.reactionData = p.reactions;
  reactionButtons(reactions, "post", p.id);
  content.append(reactions);
  const comments = node("section", undefined, "comments");
  comments.setAttribute("aria-label", "Replies to " + p.name + "’s post");
  commentsFor(p, comments);
  const form = node("form", undefined, "comment-form"),
    label = node("label", "Leave a reply"),
    input = document.createElement("textarea");
  input.id = "comment-" + p.id;
  label.htmlFor = input.id;
  input.required = true;
  input.maxLength = 1500;
  input.rows = 2;
  input.placeholder = "Join the conversation…";
  const checkLabel = node("label", undefined, "spoiler-check"),
    check = document.createElement("input");
  check.type = "checkbox";
  check.checked = p.spoiler;
  checkLabel.append(
    check,
    document.createTextNode("This reply contains spoilers"),
  );
  const button = node("button", "Post reply");
  button.type = "submit";
  form.append(label, input, checkLabel, button);
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    button.disabled = true;
    try {
      await api("tavern-feed/" + p.id + "/comments", "POST", {
        body: input.value.trim(),
        spoiler: check.checked,
      });
      input.value = "";
      await refreshPost(p.id);
    } catch (e) {
      $("#status").textContent = e.message;
    } finally {
      button.disabled = false;
    }
  };
  content.append(comments, form);
  return card;
}
async function refreshPost(id) {
  const d = await api("tavern-feed?post=" + id),
    card = feed.querySelector('[data-post="' + id + '"]');
  if (!card) return;
  if (!d.posts.length) {
    card.remove();
    return;
  }
  const p = d.posts[0];
  commentsFor(p, card.querySelector(".comments"));
  const reactions = card.querySelector(".post-reactions");
  reactions.reactionData = p.reactions;
  reactionButtons(reactions, "post", p.id);
}
async function refresh(older = false) {
  if (busy || !session?.user) return;
  busy = true;
  try {
    const d = await api(
      "tavern-feed" + (older && next ? "?before=" + next : ""),
    );
    if (!older) {
      const ids = new Set(d.posts.map((p) => String(p.id)));
      for (const card of feed.querySelectorAll("[data-post]")) {
        if (
          Number(card.dataset.post) >= Number(d.posts.at(-1)?.id || 0) &&
          !ids.has(card.dataset.post)
        ) {
          loaded.delete(Number(card.dataset.post));
          card.remove();
        }
      }
    }
    for (const p of d.posts) {
      const old = feed.querySelector('[data-post="' + p.id + '"]');
      if (old) {
        commentsFor(p, old.querySelector(".comments"));
        const reactions = old.querySelector(".post-reactions");
        reactions.reactionData = p.reactions;
        reactionButtons(reactions, "post", p.id);
        continue;
      }
      loaded.add(p.id);
      const card = postCard(p),
        before = [...feed.children].find((n) => Number(n.dataset.post) < p.id);
      if (before) feed.insertBefore(card, before);
      else feed.append(card);
    }
    if (older || !pagingInitialized) {
      next = d.nextBefore;
      pagingInitialized = true;
    }
    $("#older").hidden = !next;
    $("#status").textContent = feed.children.length
      ? "Members-only feed · Comments refresh automatically."
      : "Be the first to share something interesting with the club.";
  } catch (e) {
    $("#status").textContent = e.message;
  } finally {
    busy = false;
  }
}
$("#older").onclick = () => refresh(true);
$("#emoji").onclick = () => {
  const t = $("#caption");
  t.setRangeText("😊", t.selectionStart, t.selectionEnd, "end");
  t.focus();
};
$("#artFile").onchange = () => {
  if (previewURL) URL.revokeObjectURL(previewURL);
  previewURL = null;
  $("#attachment").replaceChildren();
  $("#attachment").hidden = true;
  if (pendingMedia) {
    api("media/" + pendingMedia, "DELETE", {}).catch(() => {});
    pendingMedia = null;
  }
  const f = $("#artFile").files[0];
  if (!f) return;
  const video = f.type.startsWith("video/");
  if (f.size > (video ? 20 : 8) * 1024 * 1024) {
    $("#status").textContent =
      "That file is too large. Choose an image under 8 MB or video under 20 MB.";
    $("#artFile").value = "";
    return;
  }
  const el = document.createElement(video ? "video" : "img");
  previewURL = URL.createObjectURL(f);
  el.src = previewURL;
  el.className = "art-media";
  if (video) el.controls = true;
  else el.alt = "Your attachment preview";
  $("#attachment").append(el);
  $("#attachment").hidden = false;
};
$("#postForm").onsubmit = async (e) => {
  e.preventDefault();
  const caption = $("#caption"),
    file = $("#artFile").files[0];
  if (!caption.value.trim() && !file) {
    $("#status").textContent = "Add a caption, link, or conversation first.";
    return;
  }
  $("#publish").disabled = true;
  $("#artFile").disabled = true;
  try {
    if (file && !pendingMedia) {
      $("#status").textContent = "Uploading your conversation…";
      const data = new FormData();
      data.append("file", file);
      const r = await fetch("/api/media", {
        method: "POST",
        credentials: "same-origin",
        headers: { "X-CSRF-Token": session.csrf },
        body: data,
      });
      const result = await r.json();
      if (!r.ok) throw Error(result.error || "Upload failed.");
      pendingMedia = result.id;
    }
    await api("chat", "POST", {
      channel: "tavern",
      body: caption.value.trim(),
      mediaId: pendingMedia,
      spoiler: $("#postSpoiler").checked,
    });
    pendingMedia = null;
    caption.value = "";
    $("#postSpoiler").checked = false;
    $("#artFile").value = "";
    $("#artFile").onchange();
    await refresh();
  } catch (e) {
    $("#status").textContent = e.message;
  } finally {
    $("#publish").disabled = false;
    $("#artFile").disabled = false;
  }
};
(async () => {
  try {
    session = await api("me");
    const allowed =
      session.user &&
      (session.user.role === "owner" || session.user.status === "active");
    if (!allowed) {
      for (const control of $("#postForm").elements) control.disabled = true;
      $("#accountNotice").hidden = false;
      $("#accountNotice").append(
        node(
          "p",
          session.user
            ? "Your membership is awaiting approval."
            : "Sign in to share conversation and join the comments.",
        ),
      );
      const a = node("a", "Member sign in");
      a.href = "sign-in.html?next=tavern";
      $("#accountNotice").append(a);
      $("#status").textContent =
        "This interesting space is for approved club members.";
      return;
    }
    await refresh();
    setInterval(() => {
      if (!document.hidden) refresh();
    }, 5000);
  } catch (e) {
    for (const control of $("#postForm").elements) control.disabled = true;
    $("#status").textContent =
      "Design preview · Start the included member server to load posts, sign in, and comment.";
  }
})();
