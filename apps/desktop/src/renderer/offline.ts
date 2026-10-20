// ShapesOS Desktop: shown when the ShapesOS server can't be reached.
const q = new URLSearchParams(location.search);
const url = q.get("url") ?? "";
const reason = q.get("reason") ?? "";
const where = document.getElementById("where");
const why = document.getElementById("why");
if (where) where.textContent = url;
if (why) why.textContent = reason;
document.getElementById("retry")?.addEventListener("click", () => {
  if (/^https?:\/\//.test(url)) location.href = url;
});
