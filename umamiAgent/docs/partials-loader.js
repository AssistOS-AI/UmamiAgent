async function initializeDocumentation() {
    await Promise.all([...document.querySelectorAll('[data-include]')].map(async (host) => {
        const response = await fetch(host.dataset.include);
        if (!response.ok) throw new Error(`Could not load ${host.dataset.include}`);
        host.innerHTML = await response.text();
    }));
    function closeMenus() {
        document.querySelectorAll('.menu').forEach((menu) => {
            menu.querySelector('button').setAttribute('aria-expanded', 'false');
            menu.querySelector('.submenu').hidden = true;
        });
    }
    document.querySelectorAll('.menu button').forEach((button) => button.addEventListener('click', () => {
        const open = button.getAttribute('aria-expanded') !== 'true';
        closeMenus();
        button.setAttribute('aria-expanded', String(open));
        button.nextElementSibling.hidden = !open;
    }));
    document.addEventListener('click', (event) => { if (!event.target.closest('.menu')) closeMenus(); });
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        const button = document.querySelector('.menu button[aria-expanded="true"]');
        closeMenus();
        button?.focus();
    });
}
initializeDocumentation().catch((error) => console.error(error));
