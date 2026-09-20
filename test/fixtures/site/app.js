(function () {
  var counter = document.getElementById('counter');
  var n = 0;
  if (counter) setInterval(function () { n += 1; counter.textContent = String(n); }, 300);
  var open = document.getElementById('open-modal');
  var close = document.getElementById('close-modal');
  var modal = document.getElementById('modal');
  if (open && modal) open.addEventListener('click', function () { modal.hidden = false; });
  if (close && modal) close.addEventListener('click', function () { modal.hidden = true; });
  var menuButton = document.querySelector('.has-menu .nav-link');
  if (menuButton) menuButton.addEventListener('click', function () {
    var li = menuButton.closest('.has-menu');
    var openNow = li.classList.toggle('open');
    menuButton.setAttribute('aria-expanded', String(openNow));
  });
  var hamburger = document.querySelector('.hamburger');
  var drawer = document.getElementById('drawer');
  if (hamburger && drawer) hamburger.addEventListener('click', function () {
    drawer.hidden = !drawer.hidden;
    hamburger.setAttribute('aria-expanded', String(!drawer.hidden));
  });
})();
