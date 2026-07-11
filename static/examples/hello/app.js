// A tiny bit of life: cycle the greeting, and let visitors say hi back.
const names = ["world", "friend", "stranger", "internet", "you"];
let i = 0;
const who = document.getElementById("who");
setInterval(() => {
  i = (i + 1) % names.length;
  who.textContent = names[i];
}, 2200);

const cta = document.getElementById("cta");
const sub = document.getElementById("sub");
let hi = 0;
cta.addEventListener("click", () => {
  hi++;
  sub.textContent = hi === 1
    ? "👋 Hi back. Edit this in the unhosted.dev IDE and share your own."
    : `👋 × ${hi}. Keep going, it's just a button.`;
  cta.animate(
    [{ transform: "scale(1)" }, { transform: "scale(0.92)" }, { transform: "scale(1)" }],
    { duration: 160, easing: "ease-out" },
  );
});
