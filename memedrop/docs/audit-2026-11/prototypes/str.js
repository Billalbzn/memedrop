const msg = JSON.parse('{"type":"register","identity":{"userId":{"toString":1}}}');
try { String(msg.identity.userId || ''); console.log('no throw'); } catch (e) { console.log('THROWS:', e.constructor.name, e.message); }
try { [{"toString":1}].map(String); console.log('no throw'); } catch (e) { console.log('map THROWS:', e.message); }
try { encodeURIComponent(('a' + '\u{1F525}'.repeat(199)).slice(0,200)); console.log('no throw'); } catch (e) { console.log('URI THROWS:', e.message); }
try { new URL('//localhost:99999/', 'http://localhost'); console.log('no throw') } catch (e) { console.log('URL THROWS:', e.message); }
try { new URL('//[', 'http://localhost'); console.log('no throw') } catch (e) { console.log('URL2 THROWS:', e.message); }
