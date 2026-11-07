"use strict";
/* Optional shared mode is enabled by server.py, never by Live Server.
   The default HTML download still works without Python or network access. */
let memberSession = { user: null, csrf: "", revision: 0, joinCode: "" };
let sharedMembers = [],
  voteTotals = {},
  memberBusy = false,
  progressTimer;
titles.login = "Member sign in";
renderers.login = () => {
  if (!window.CLUB_SERVER)
    return `<p>Live Server previews the website design. To use shared accounts and discussions, start the included member server.</p><p>Follow README.md in your downloaded code folder to start server.py.</p><p class="notice">No member account is created in local preview mode.</p>`;
  if (memberSession.user)
    return `<p>Signed in as <strong>${esc(memberSession.user.name)}</strong>.</p><button class="outline" id="signOut">Sign out</button>`;
  return `<p>Sign in to discuss books, vote, and save your reading progress.</p><form id="loginForm"><label for="loginUsername">Username</label><input id="loginUsername" name="username" autocomplete="username" required maxlength="60"><label for="loginPassword">Password</label><input id="loginPassword" name="password" type="password" autocomplete="current-password" required maxlength="256"><div class="actions"><button class="primary">Sign in</button></div></form><details><summary>Join the club with an invitation code</summary><form id="registerForm"><label for="joinName">Reader/display name</label><input id="joinName" name="name" maxlength="60" required><label for="joinUsername">Choose a username</label><input id="joinUsername" name="username" autocomplete="username" minlength="3" maxlength="60" pattern="[a-zA-Z0-9_.-]{3,60}" required><label for="joinPassword">Password (12 characters minimum)</label><input id="joinPassword" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="256" required><label for="joinCode">Club invitation code</label><input id="joinCode" name="joinCode" maxlength="200" required><label for="joinBirthDate">Date of birth (checked, not stored)</label><input id="joinBirthDate" type="date" name="birthDate" required><label class="check-label"><input type="checkbox" name="adultConsent" value="yes" required>I am 18 or older and agree to the 18+ membership rules and privacy notice.</label><p>New accounts require owner approval before joining member rooms.</p><div class="actions"><button class="primary">Create member account</button></div></form></details><p class="meta">Ask the owner for an invitation code. Contact the owner if you need an account reset; automated password recovery is not included.</p>`;
};
async function api(path, method = "GET", body) {
  const headers = {};
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    headers["X-CSRF-Token"] = memberSession.csrf;
  }
  const response = await fetch(`/api/${path}`, {
    method,
    headers,
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      "The member server did not return valid data. Check that it is running.",
    );
  }
  if (!response.ok)
    throw new Error(result.error || "Could not complete that action.");
  return result;
}
async function syncShared(refreshContent = false) {
  memberSession = await api("me");
  if (refreshContent) {
    const fresh = await api("config");
    config = validateConfig(fresh.config);
    memberSession.revision = fresh.revision;
    renderHome();
  }
  const button = document.querySelector("#accountButton");
  button.textContent = memberSession.user ? "My account" : "Member sign in";

  if (
    memberSession.user &&
    (memberSession.user.role === "owner" ||
      memberSession.user.status === "active")
  ) {
    const data = await api("state");
    reader = validateReader(data.reader);
    sharedMembers = data.members;
    voteTotals = data.totals;
  } else {
    reader = newReader();
    sharedMembers = [];
    voteTotals = {};
  }
  renderHome();
  document.querySelector("#localNotice").textContent = memberSession.user
    ? `Member server connected · Signed in as ${memberSession.user.name}. Your membership status: ${memberSession.user.status}.`
    : "Member server connected · Sign in to join your club’s conversations.";
}
async function memberAction(work, message) {
  if (memberBusy) return;
  memberBusy = true;
  try {
    await work();
    await syncShared();
    if (room.open) renderRoom();
    if (message) toast(message);
  } catch (error) {
    toast(error.message);
  } finally {
    memberBusy = false;
  }
}
function requireMember() {
  if (
    memberSession.user &&
    (memberSession.user.role === "owner" ||
      memberSession.user.status === "active")
  )
    return true;
  openRoom("login");
  return false;
}
if (window.CLUB_SERVER) {
  const localDiscussions = renderers.discussions,
    localEvents = renderers.events,
    localVote = renderers.vote,
    localProfile = renderers.profile;
  renderers.discussions = () =>
    localDiscussions().replace(
      "Local preview: posts and replies stay in this browser. Other members cannot see them without an online database.",
      "Shared club room: conversations are visible to signed-in club members. Discussions refresh automatically while this room is open.",
    );
  renderers.events = () =>
    localEvents().replace(
      "RSVPs save locally and do not notify the organizer.",
      "Your RSVP saves to the club database. Automatic email notifications are not included.",
    );
  renderers.vote = () =>
    localVote().replace(
      "Your choice is local. This does not tally votes from other devices.",
      "Your choice is shared with the club. Each member has one choice for the next selection.",
    ) +
    `<div class="card"><h3>Club vote totals</h3>${config.upcoming.map((b) => `<p>${esc(b.title)}: <strong>${voteTotals[b.id] || 0}</strong></p>`).join("")}</div>`;
  renderers.members = () =>
    `<p>Your fellow readers.</p>${sharedMembers.map((m) => `<article class="card"><h3>${esc(m.name)}</h3><p class="post-text">${esc(m.bio || "A kindred spirit between the pages.")}</p></article>`).join("")}`;
  renderers.profile = () =>
    localProfile()
      .replace(
        "This profile is local and is not an online sign-in.",
        "Your reader profile saves to your member account.",
      )
      .replace(
        "<details><summary>Back up or restore all your data</summary>",
        "<details hidden><summary>Back up or restore all your data</summary>",
      ) +
    `<div class="actions"><button class="outline" id="signOut">Sign out</button></div>${memberSession.user?.role === "owner" ? `<p class="notice">Club invitation code: <strong>${esc(memberSession.joinCode)}</strong>. Share it with the people you want to join. Keep your owner password private.</p>` : ""}`;
  const originalPostBody = postBody;
  postBody = (post) =>
    originalPostBody(post) +
    (post.canDelete
      ? `<div class="actions"><button class="outline danger" data-delete-post="${esc(post.id)}">Delete conversation</button></div>`
      : "");
  document.addEventListener(
    "click",
    (event) => {
      const b = event.target.closest("button");
      if (!b) return;
      if (
        b.dataset.room &&
        ["profile", "members", "discussions", "vote", "tavern", "art"].includes(
          b.dataset.room,
        )
      ) {
        if (
          !memberSession.user ||
          (memberSession.user.role !== "owner" &&
            memberSession.user.status !== "active")
        ) {
          event.preventDefault();
          event.stopImmediatePropagation();
          openRoom("login", b);
          return;
        }
      }
      if (b.id === "signOut") {
        event.preventDefault();
        event.stopImmediatePropagation();
        memberAction(() => api("logout", "POST", {}), "Signed out.").then(
          () => {
            if (!memberSession.user) openRoom("login");
          },
        );
        return;
      }
      if (
        b.dataset.vote ||
        b.dataset.rsvp ||
        b.dataset.like ||
        b.dataset.deletePost
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!requireMember()) return;
        if (b.dataset.vote)
          memberAction(
            () =>
              api("vote", "PUT", {
                bookId: config.current.id,
                choice: b.dataset.vote,
              }),
            "Your club vote was saved.",
          );
        if (b.dataset.rsvp)
          memberAction(
            () => api("rsvp", "POST", { eventId: b.dataset.rsvp }),
            "Your club RSVP was updated.",
          );
        if (b.dataset.like)
          memberAction(() =>
            api(`posts/${encodeURIComponent(b.dataset.like)}/like`, "POST", {}),
          );
        if (
          b.dataset.deletePost &&
          confirm("Delete this conversation and all its replies?")
        )
          memberAction(
            () =>
              api(
                `posts/${encodeURIComponent(b.dataset.deletePost)}`,
                "DELETE",
                {},
              ),
            "Conversation deleted.",
          );
      }
    },
    true,
  );
  document.addEventListener(
    "submit",
    (event) => {
      const f = event.target;
      if (
        !f.matches(
          "#loginForm,#registerForm,#postForm,[data-reply],#profileForm",
        )
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const fd = new FormData(f),
        v = (n) => String(fd.get(n) || "").trim();
      if (f.id === "loginForm" || f.id === "registerForm") {
        memberAction(
          () =>
            api(
              f.id === "loginForm" ? "login" : "register",
              "POST",
              Object.fromEntries(fd),
            ),
          f.id === "loginForm" ? "Welcome back." : "Welcome to the club.",
        ).then(() => {
          if (memberSession.user) openRoom("profile");
        });
        return;
      }
      if (!requireMember()) return;
      if (f.id === "postForm")
        memberAction(
          () =>
            api("posts", "POST", {
              bookId: f.dataset.bookId,
              title: v("title"),
              body: v("body"),
              spoiler: fd.has("spoiler"),
            }),
          "Conversation shared with your club.",
        );
      if (f.dataset.reply)
        memberAction(
          () =>
            api(
              `posts/${encodeURIComponent(f.dataset.reply)}/replies`,
              "POST",
              { body: v("reply") },
            ),
          "Reply shared.",
        );
      if (f.id === "profileForm")
        memberAction(
          () => api("profile", "PUT", { name: v("name"), bio: v("bio") }),
          "Member profile saved.",
        );
    },
    true,
  );
  document.addEventListener(
    "input",
    (event) => {
      if (event.target.id !== "readingProgress") return;
      event.stopImmediatePropagation();
      if (!requireMember()) return;
      const bookId = event.target.dataset.bookId,
        chapter = Number(event.target.value);
      if (bookId !== config.current.id) {
        toast(
          "The club changed its current book. Your reading room has been refreshed.",
        );
        renderRoom();
        return;
      }
      document.querySelector("#chapterLabel").textContent =
        `${chapter} / ${config.current.chapters} chapters`;
      reader.progress[bookId] = chapter;
      renderHome();
      clearTimeout(progressTimer);
      progressTimer = setTimeout(
        () =>
          api("progress", "PUT", { bookId, chapter }).catch((error) =>
            toast(error.message),
          ),
        450,
      );
    },
    true,
  );
  document.addEventListener(
    "change",
    (event) => {
      if (event.target.id === "restoreBackup") {
        event.stopImmediatePropagation();
        toast("Use the server database backup procedure for shared data.");
      }
    },
    true,
  );
  syncShared(true).catch((error) => {
    document.querySelector("#localNotice").textContent =
      `Member server connection failed: ${error.message}`;
    toast(
      "Could not connect to the member server. Refresh after checking it is running.",
    );
  });
  setInterval(async () => {
    if (memberBusy || document.hidden) return;
    try {
      await syncShared(true);
      if (
        room.open &&
        ["discussions", "members", "vote"].includes(activeRoom)
      ) {
        // Avoid losing a half-written post or reply. The member can close/reopen to refresh.
        const writing = [
          ...roomContent.querySelectorAll("input,textarea"),
        ].some((e) => e.value.trim());
        if (!writing) renderRoom();
      }
    } catch {}
  }, 20000);
}

// GitHub Pages is a design preview: never submit account credentials into a URL.
if (!window.CLUB_SERVER) {
  document.addEventListener(
    "submit",
    (event) => {
      if (event.target.matches("#loginForm,#registerForm")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        toast(
          "Accounts need the Python member server. See README.md to start it.",
        );
      }
    },
    true,
  );
  document.addEventListener("DOMContentLoaded", () => {
    document
      .querySelectorAll(
        "#loginForm input,#loginForm button,#registerForm input,#registerForm button",
      )
      .forEach((el) => (el.disabled = true));
    if (document.body.dataset.page === "login")
      document.querySelector("#localNotice").textContent =
        "Design preview only. Accounts require the Python member server; no details are submitted here.";
  });
}
