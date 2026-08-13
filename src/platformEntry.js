const mobileQuery = window.matchMedia("(hover: none) and (pointer: coarse)");
const compactTouchQuery = window.matchMedia("(max-width: 900px)");
const userAgentMobile = navigator.userAgentData?.mobile === true
  || /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(navigator.userAgent);
const touchOnlyDevice = mobileQuery.matches
  || (navigator.maxTouchPoints > 0 && compactTouchQuery.matches);

if (userAgentMobile || touchOnlyDevice) {
  const gameFrame = document.querySelector("#game-frame");
  const canvas = document.querySelector("#pixel-game-canvas");
  const gameStatus = document.querySelector("#game-status");

  document.documentElement.dataset.platform = "mobile";
  gameFrame.dataset.ready = "mobile";
  canvas.hidden = true;
  canvas.removeAttribute("tabindex");
  canvas.setAttribute("aria-hidden", "true");
  gameStatus.textContent = "BLOCKSTEP mobile version is under development. Use a desktop or laptop with a physical keyboard to play.";
} else {
  document.documentElement.dataset.platform = "desktop";
  import("./pixelGame.js").catch((error) => {
    const gameFrame = document.querySelector("#game-frame");
    const gameGate = document.querySelector("#game-gate");
    const gameStatus = document.querySelector("#game-status");
    gameFrame.dataset.ready = "error";
    gameGate.querySelector(".game-gate-status strong").textContent = "BLOCKSTEP COULD NOT START";
    gameGate.querySelector(".game-gate-status span").textContent = error.message;
    gameStatus.textContent = `BLOCKSTEP could not start: ${error.message}`;
    console.error(error);
  });
}
