"use strict";
// Real document navigation; keep homepage buttons and their styling unchanged.
window.CLUB_PAGE_ROUTES = {
  current: "current-read.html",
  discussions: "discussions.html",
  upcoming: "upcoming-books.html",
  members: "members.html",
  events: "events.html",
  shop: "shop.html",
  about: "about.html",
  announcements: "announcements.html",
  vote: "polls.html",
  art: "fan-art.html",
  tavern: "tavern.html",
  rules: "rules.html",
  profile: "profile.html",
  search: "search.html",
  login: "sign-in.html",
  admin: "admin.html",
};
window.goClubPage = function (name) {
  let target = window.CLUB_PAGE_ROUTES[name];
  if (!target) return;
  const next = new URLSearchParams(location.search).get("next");
  if (
    name === "profile" &&
    document.body.dataset.page === "login" &&
    window.CLUB_PAGE_ROUTES[next]
  )
    target = window.CLUB_PAGE_ROUTES[next];
  if (
    name === "login" &&
    document.body.dataset.page &&
    document.body.dataset.page !== "login"
  )
    target += "?next=" + encodeURIComponent(document.body.dataset.page);
  location.assign(target);
};
document.addEventListener(
  "click",
  function (event) {
    const target = event.target.closest("[data-room]");
    if (!target || !window.CLUB_PAGE_ROUTES[target.dataset.room]) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.goClubPage(target.dataset.room);
  },
  true,
);
