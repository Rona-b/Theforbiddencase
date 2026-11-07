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
function commentsFor(post, holder) {
  holder.replaceChildren(node("strong", post.comments.length + " comments"));
  for (const c of post.comments) {
    const box = node("div", undefined, "comment");
    box.append(node("strong", c.name));
    const body = node("p");
    linked(body, c.body);
    box.append(
      body,
      node("time", new Date(c.created).toLocaleString(), "timestamp"),
    );
    if (c.canDelete)
      deleteButton(box, "Remove comment", "art-comments/" + c.id, () =>
        refresh(),
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
  const body = node("p", undefined, "post-body");
  linked(body, p.body);
  card.append(head, body);
  media(card, p.media);
  if (p.canDelete)
    deleteButton(card, "Remove post", "chat/" + p.id, () => {
      card.remove();
      loaded.delete(p.id);
      refresh();
    });
  const comments = node("section", undefined, "comments");
  comments.setAttribute("aria-label", "Comments on " + p.name + "’s post");
  commentsFor(p, comments);
  const form = node("form", undefined, "comment-form"),
    label = node("label", "Leave a comment"),
    input = document.createElement("textarea");
  input.id = "comment-" + p.id;
  label.htmlFor = input.id;
  input.required = true;
  input.maxLength = 1500;
  input.rows = 2;
  input.placeholder = "Encourage the artist or join the conversation…";
  const button = node("button", "Post comment");
  button.type = "submit";
  form.append(label, input, button);
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    button.disabled = true;
    try {
      await api("art-feed/" + p.id + "/comments", "POST", {
        body: input.value.trim(),
      });
      input.value = "";
      await refresh();
    } catch (e) {
      $("#status").textContent = e.message;
    } finally {
      button.disabled = false;
    }
  };
  card.append(comments, form);
  return card;
}
async function refresh(older = false) {
  if (busy || !session?.user) return;
  busy = true;
  try {
    const d = await api("art-feed" + (older && next ? "?before=" + next : ""));
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
      : "Be the first to share something creative with the club.";
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
    $("#status").textContent = "Add a caption, link, or artwork first.";
    return;
  }
  $("#publish").disabled = true;
  $("#artFile").disabled = true;
  try {
    if (file && !pendingMedia) {
      $("#status").textContent = "Uploading your artwork…";
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
      channel: "art",
      body: caption.value.trim(),
      mediaId: pendingMedia,
    });
    pendingMedia = null;
    caption.value = "";
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
            : "Sign in to share artwork and join the comments.",
        ),
      );
      const a = node("a", "Member sign in");
      a.href = "sign-in.html?next=art";
      $("#accountNotice").append(a);
      $("#status").textContent =
        "This creative space is for approved club members.";
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
