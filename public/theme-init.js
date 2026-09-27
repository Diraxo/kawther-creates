/* Apply the saved theme before first paint (no dark/light flash). External (not inline) so the CSP needs no 'unsafe-inline' for scripts. */
try{var t=localStorage.getItem('kc_theme')||'dark';if(t==='system')t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.setAttribute('data-theme',t);}catch(e){}
