let timer;
export function toast(msg, ms = 2600) {
  let t = document.getElementById('kc-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'kc-toast';
    t.className = 'kc-toast';
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.remove('show');
  void t.offsetWidth;
  t.classList.add('show');
  clearTimeout(timer);
  timer = setTimeout(() => t.classList.remove('show'), ms);
}
