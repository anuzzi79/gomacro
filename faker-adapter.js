// Loaded in page context to provide Faker-based random text generation.
// This script defines window.__fakerAdapter with:
//  - fake(kind): Promise<string>
//  - kinds(): string[]
(async function() {
  try {
    if (window.__fakerAdapter) return;
    async function loadFaker() {
      if (window.__faker) return window.__faker;
      // Prefer local vendored UMD to avoid CSP/network issues
      const loadLocal = () => new Promise((resolve, reject) => {
        if (window.faker) return resolve(window.faker);
        try {
          const s = document.createElement('script');
          // chrome.runtime may be unavailable in rare sandboxed scopes; guard it
          const url = (typeof chrome !== 'undefined' && chrome.runtime?.getURL)
            ? chrome.runtime.getURL('vendor/faker.umd.min.js')
            : null;
          if (!url) return reject(new Error('Runtime URL not available'));
          s.src = url;
          s.async = true;
          s.onload = () => {
            if (window.faker) resolve(window.faker);
            else reject(new Error('Local Faker UMD loaded but global not found'));
          };
          s.onerror = () => reject(new Error('Failed to load local Faker UMD'));
          (document.head || document.documentElement).appendChild(s);
          setTimeout(() => {
            if (!window.faker) reject(new Error('Timeout loading local Faker UMD'));
          }, 3000);
        } catch (e) {
          reject(e);
        }
      });

      // As a last resort, try CDN (kept for compatibility; can be removed)
      const loadFromCdn = () => new Promise((resolve, reject) => {
        if (window.faker) return resolve(window.faker);
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/@faker-js/faker@8.4.1/dist/faker.umd.min.js';
        s.async = true;
        s.onload = () => {
          if (window.faker) resolve(window.faker);
          else reject(new Error('Faker UMD loaded but global not found'));
        };
        s.onerror = () => reject(new Error('Failed to load Faker UMD'));
        // Append into <head> – if page CSP blocks, we'll catch and fallback
        (document.head || document.documentElement).appendChild(s);
        // Safety timeout
        setTimeout(() => {
          if (!window.faker) reject(new Error('Timeout loading Faker UMD'));
        }, 4000);
      });
      try {
        // Try local first (offline vendor)
        const f = await loadLocal();
        window.__faker = f;
        return f;
      } catch (e) {
        try {
          // Optional CDN fallback
          const f2 = await loadFromCdn();
          window.__faker = f2;
          return f2;
        } catch (err) {
          window.__faker_unavailable = true;
          throw err;
        }
      }
    }

    const KIND_MAP = {
      firstName: f => f.person.firstName(),
      lastName: f => f.person.lastName(),
      fullName: f => f.person.fullName(),
      userName: f => f.internet.userName(),
      email: f => f.internet.email(),
      password: f => f.internet.password(),
      phone: f => f.phone.number(),
      color: f => f.color.human(),
      uuid: f => f.string.uuid(),
      number4: f => String(f.number.int({ min: 1000, max: 9999 })),
      company: f => f.company.name(),
      jobTitle: f => f.person.jobTitle(),
      city: f => f.location.city(),
      country: f => f.location.country(),
      url: f => f.internet.url(),
      ip: f => f.internet.ip(),
      word: f => f.word.sample(),
      sentence: f => f.lorem.sentence(),
      paragraph: f => f.lorem.paragraph(),
    };

    window.__fakerAdapter = {
      async fake(kind) {
        if (window.__faker_unavailable) {
          throw new Error('Faker not available for lack of internet');
        }
        const f = await loadFaker();
        const fn = KIND_MAP[kind] || KIND_MAP.word;
        return fn(f);
      },
      kinds() {
        return Object.keys(KIND_MAP);
      }
    };
  } catch (e) {
    // Expose a minimal stub that always fails with a clear message
    window.__fakerAdapter = {
      async fake() { throw new Error('Faker not available for lack of internet'); },
      kinds() { return []; }
    };
  }
})();


