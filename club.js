"use strict";
// Club page extensions, owner moderation and monthly artwork.
titles.shop = "Book Club Shop";
renderers.shop = () =>
  "<p>Our bookish shop is coming soon. Check back for club treasures.</p>";
const originalOpenRoom = openRoom;
openRoom = function (name, trigger) {
  if (
    ["tavern", "discussions", "members", "profile", "vote", "art"].includes(
      name,
    )
  ) {
    if (!window.CLUB_SERVER || !memberSession.user) {
      originalOpenRoom("login", trigger);
      return;
    }
    if (
      memberSession.user.role !== "owner" &&
      memberSession.user.status !== "active"
    ) {
      originalOpenRoom("login", trigger);
      return;
    }
  }
  originalOpenRoom(name, trigger);
  if (name === "admin") refreshAdmin();
};
const accountRenderer = renderers.login;
renderers.login = () =>
  accountRenderer() +
  (memberSession.user?.status === "pending"
    ? '<p class="notice">Your request is awaiting owner approval. Sign out and sign back in after approval.</p>'
    : "");
const profileRenderer = renderers.profile;
renderers.profile = () =>
  profileRenderer() +
  (memberSession.user?.role === "owner"
    ? '<button class="outline" data-room="admin">Manage membership</button>'
    : "");
renderers.rules = () =>
  `<p>This fantasy romance club is exclusively for adults aged 18 and older. Do not register if you are under 18.</p><p>Membership requires an invitation, an adult declaration, and owner approval. False declarations and abusive behavior may lead to removal. Mark spoilers, respect fellow readers, and do not post private information, threats, harassment, or unlawful content.</p><h3>Privacy</h3><p>We store your username, display name, password hash, adult declaration, approval status, profile, messages, uploaded photos/GIFs/videos, discussions, reading progress, votes, and RSVPs. Date of birth is checked during signup and is not stored. Other approved members can see your display name, profile, and contributions. The owner can moderate and remove accounts and shared media. Uploaded images may contain camera/location metadata; remove that information before sharing. External links open other websites, whose privacy policies apply. Sign-in attempt IP addresses are retained for up to 15 minutes. Sessions use a necessary sign-in cookie; this code includes no advertising trackers.</p><p>Ask the owner to remove your account or report a suspected underage member. Account removal deletes your contributions from the active database and blocks your old username; backups may retain earlier data until the owner deletes them.</p>`;
titles.admin = "Manage membership";
renderers.admin = () =>
  memberSession.user?.role === "owner"
    ? '<p>Approve adults you have invited. Remove a member to revoke access and delete their contributions. Removing a member also rotates the invitation code.</p><div id="adminUsers">Loading members…</div>'
    : "<p>Owner access required.</p>";
async function refreshAdmin() {
  try {
    const data = await api("admin/users");
    const el = document.querySelector("#adminUsers");
    if (!el) return;
    el.innerHTML = data.users
      .map(
        (u) =>
          `<article class="card"><h3>${esc(u.name)}</h3><p>${esc(u.username)} · ${esc(u.status)} · ${u.adult_attested ? "18+ declared" : "Adult declaration needed"}</p>${u.role === "owner" ? "<p>Club owner</p>" : `<div class="actions">${u.status === "pending" ? `<button class="outline" data-approve-user="${esc(u.id)}">Approve adult member</button>` : ""}<button class="outline danger" data-remove-user="${esc(u.id)}">Remove member</button></div>`}</article>`,
      )
      .join("");
  } catch (e) {
    toast(e.message);
  }
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  try {
    if (b.dataset.approveUser) {
      await api(
        "admin/users/" + encodeURIComponent(b.dataset.approveUser) + "/approve",
        "POST",
        {},
      );
      await refreshAdmin();
    }
    if (
      b.dataset.removeUser &&
      confirm(
        "Remove this member, delete their contributions, and rotate the invitation code?",
      )
    ) {
      await api(
        "admin/users/" + encodeURIComponent(b.dataset.removeUser),
        "DELETE",
        {},
      );
      await syncShared();
      await refreshAdmin();
      toast("Member removed. See My profile for the new invitation code.");
    }
  } catch (error) {
    toast(error.message);
  }
});
// Separate original desktop and portrait mobile artwork; both follow the same theme.
let loadedShelfPath = "",
  pendingShelfPath = "",
  loadedMobilePath = "",
  pendingMobilePath = "";
function setMonthlyArtwork() {
  const candidate = shelfImage(),
    library = document.querySelector(".library, .page-library");
  if (!library) return;
  if (candidate === loadedShelfPath)
    library.style.setProperty("--shelf-image", `url("${candidate}")`);
  else if (candidate !== pendingShelfPath) {
    pendingShelfPath = candidate;
    const img = new Image();
    img.onload = () => {
      if (candidate !== shelfImage()) return;
      loadedShelfPath = candidate;
      pendingShelfPath = "";
      library.style.setProperty("--shelf-image", `url("${candidate}")`);
    };
    img.onerror = () => {
      if (pendingShelfPath === candidate) pendingShelfPath = "";
      library.style.setProperty(
        "--shelf-image",
        'url("images/library-backdrop.png")',
      );
    };
    img.src = candidate;
  }
  const monthName =
    config.theme === "original"
      ? MONTH_THEMES[new Date().getMonth()][0]
      : candidate.split("/").pop().replace(".png", "");
  const mobilePath = "images/mobile-monthly/" + monthName + ".png";
  if (mobilePath === loadedMobilePath)
    library.style.setProperty("--mobile-shelf-image", `url("${mobilePath}")`);
  else if (mobilePath !== pendingMobilePath) {
    pendingMobilePath = mobilePath;
    const small = new Image();
    small.onload = () => {
      if (pendingMobilePath !== mobilePath) return;
      loadedMobilePath = mobilePath;
      pendingMobilePath = "";
      library.style.setProperty("--mobile-shelf-image", `url("${mobilePath}")`);
    };
    small.onerror = () => {
      if (pendingMobilePath === mobilePath) pendingMobilePath = "";
    };
    small.src = mobilePath;
  }
}
setInterval(setMonthlyArtwork, 60000);
const homeRenderer = renderHome;
renderHome = function () {
  homeRenderer();
  setMonthlyArtwork();
};
setMonthlyArtwork();
// Match typography to the actual bookcase width, including wide screens and zoom.
function scaleShelf() {
  const library = document.querySelector(".library, .page-library");
  library.style.setProperty(
    "--shelf-unit",
    library.getBoundingClientRect().width / 1536 + "px",
  );
}
if (document.querySelector(".library")) {
  new ResizeObserver(scaleShelf).observe(document.querySelector(".library"));
  scaleShelf();
}
titles.announcements = "Club announcements";
renderers.announcements = () =>
  config.announcements
    .map((line) => `<article class="card"><p>${esc(line)}</p></article>`)
    .join("") || "<p>No announcements yet.</p>";
const fitHomeRenderer = renderHome;
renderHome = function () {
  fitHomeRenderer();
  document.querySelector("#announcementList").innerHTML =
    config.announcements
      .slice(0, 2)
      .map((line) => `<li>${esc(line)}</li>`)
      .join("") || "<li>Welcome to the club.</li>";
  document.querySelector("#homeEvents").innerHTML =
    config.events
      .slice(0, 2)
      .map((event) => `<li>${esc(event.title)} — ${esc(event.date)}</li>`)
      .join("") || "<li>No gatherings scheduled.</li>";
  scaleShelf();
};
renderHome();
// Refit each navigation label to the clear leather area without changing the shelves.
function fitNavigationLabels() {
  document.querySelectorAll(".nav-book").forEach((book) => {
    const title = book.querySelector(".nav-title");
    if (!title) return;
    const height = book.getBoundingClientRect().height;
    let size = Math.min(18, height * 0.105);
    title.style.fontSize = size + "px";
    const availableHeight = height * 0.25;
    while (
      size > 8 &&
      (title.scrollWidth > title.clientWidth + 1 ||
        title.scrollHeight > availableHeight)
    ) {
      size -= 0.5;
      title.style.fontSize = size + "px";
    }
  });
}
if (document.querySelector(".book-nav"))
  new ResizeObserver(fitNavigationLabels).observe(
    document.querySelector(".book-nav"),
  );
document.fonts.ready.then(fitNavigationLabels);
window.addEventListener("resize", fitNavigationLabels);
requestAnimationFrame(fitNavigationLabels);
