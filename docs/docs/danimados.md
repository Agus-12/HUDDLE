# Danimados — Documentación Técnica

## Datos generales
- **URL**: https://danimados.cc
- **Tipo**: Animación (series, sin películas)
- **Catálogo**: 823 series (snapshot completo en `dani-catalogo.json`)
- **Idioma**: Latino
- **Calidad**: HD
- **Protocolo**: HTTP puro (WordPress + Dooplay, sin Cloudflare)

## Fuente principal de caricaturas en Huddle
Reemplaza las series rotas de MisCaricaturas y Lacartoons.
Ejemplo: Teen Titans Go (9 temporadas, 291 episodios).

## Cómo funciona el catálogo
1. Snapshot de 823 series en `public/dani-catalogo.json` (slug → {t, p})
2. Portadas de IMDb en `public/dani-imdb.json`
3. Página de serie: `/series/<slug>/` → lista de episodios por temporada
4. Episodio: `/episodios/<slug>-<T>x<E>/`

## Flujo de resolución (`daniEpToStream`)
```
1. Descargar página del episodio
2. Extraer data-post (ID de WordPress)
3. Para cada nume (1-4):
   a. POST /wp-admin/admin-ajax.php (doo_player_ajax)
   b. Obtener embed_url
   c. Si es iframe HTML → extraer src
   d. Fetch del embed → buscar .m3u8 o eval packer
   e. Si es vimeus/vimeos → resolverVimeos
   f. Desempacar Dean Edwards packer
   g. Extraer m3u8 del resultado
   h. Fetch del master con UA grande (cdn-centaurus)
   i. Si es #EXTM3U → cachear en pelisxdStreams, servir por /api/xd/
4. Si ningún player funciona → error
```

## Packer Dean Edwards
Muchos episodios ofuscan el m3u8 con `eval(function(p,a,c,k,e,d){...})`:
```javascript
daniDesempacar(html) → ejecuta el payload → string con URLs
```

## Series reemplazadas
Series nuestras rotas que ahora sirven la versión de Danimados:
- Teen Titans Go, Bob Esponja, Hora de Aventura, Los Simpson, etc.
- Mapa `DANI_REEMPLAZAS`: nuestro slug → slug de Danimados

## Archivos en disco
- `public/dani-catalogo.json` — catálogo de 823 series
- `public/dani-imdb.json` — portadas de IMDb
- `data/dani-catalogo.json` — respaldo del catálogo