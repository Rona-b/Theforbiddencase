"use strict";
(async function initializePage() {
  const page = document.body.dataset.page;
  // The HTML file owns the heading and public page markup, not a JS renderer.
  titles[page] = roomTitle.textContent;
  const sharedHomeRenderer = renderHome;
  renderHome = function () {
    sharedHomeRenderer();
    document.title = titles[page] + " — " + config.name;
  };
  document.querySelectorAll(".nav-book").forEach((book) => {
    const selected =
      book.dataset.room === page ||
      (page === "current" && book.getAttribute("href") === "current-read.html");
    if (selected) book.setAttribute("aria-current", "page");
  });

  if (roomContent.dataset.editableHtml === "true") {
    const editableHTML = roomContent.innerHTML;
    const liveRenderer = renderers[page];
    renderers[page] = () =>
      page === "login" && memberSession.user ? liveRenderer() : editableHTML;
    const renderDynamic = renderRoom;
    renderRoom = function () {
      renderDynamic();
      const postList = document.querySelector("#postList");
      if (postList) postList.innerHTML = renderPosts();
      const totals = document.querySelector("#pageVoteTotals");
      if (totals)
        totals.innerHTML =
          "<h3>Club vote totals</h3>" +
          config.upcoming
            .map(
              (b) =>
                "<p>" +
                esc(b.title) +
                ": <strong>" +
                (voteTotals[b.id] || 0) +
                "</strong></p>",
            )
            .join("");
      const name = document.querySelector("#readerName"),
        bio = document.querySelector("#readerBio");
      if (name) name.value = reader.profile.name;
      if (bio) bio.value = reader.profile.bio;
      const ownerControls = document.querySelector("#pageOwnerControls");
      if (ownerControls && memberSession.user?.role === "owner")
        ownerControls.innerHTML =
          '<button class="outline" data-room="admin">Manage membership</button><p class="meta">Invitation code: ' +
          esc(memberSession.joinCode) +
          "</p>";
      const progress = document.querySelector("#readingProgress");
      if (progress) {
        const n = reader.progress[progress.dataset.bookId] || 0;
        progress.value = n;
        document.querySelector("#chapterLabel").textContent =
          n + " / " + progress.max + " chapters";
      }
      document.querySelectorAll("[data-vote]").forEach((b) => {
        b.textContent =
          reader.votes[config.current.id] === b.dataset.vote
            ? "✓ Your choice"
            : "Choose this book";
      });
      document.querySelectorAll("[data-rsvp]").forEach((b) => {
        b.textContent = reader.rsvps.includes(b.dataset.rsvp)
          ? "✓ Going · Undo RSVP"
          : "Count me in";
      });
    };
  }
  document.querySelectorAll(".page-links a").forEach((a) => {
    if (a.getAttribute("href") === window.CLUB_PAGE_ROUTES[page])
      a.setAttribute("aria-current", "page");
  });
  try {
    if (window.CLUB_SERVER) await syncShared(true);
    openRoom(page);
    document.title = (titles[page] || "Book Club") + " — " + config.name;
    const jump = document.createElement("a");
    jump.href = "#room";
    jump.textContent =
      "⚔ " + (titles[page] || "Book Club") + " — Open this page ↓";
    document.querySelector(".utility>span").replaceChildren(jump);
  } catch (error) {
    roomTitle.textContent = "Connection unavailable";
    roomContent.textContent =
      "Please check that the member server is running, then refresh this page. " +
      error.message;
  } finally {
    roomContent.removeAttribute("aria-busy");
  }
})();
