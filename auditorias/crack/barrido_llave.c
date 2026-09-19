/* v223.5: busca la llave de firma wsSecret probando TODOS los tramos de bytes
   de un archivo como llave (8/16/24/32 bytes) contra una muestra real.
   Uso: ./barrido_llave <archivo> [<archivo>...]                        */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <openssl/md5.h>

static const char *RUTA = "/vod/1/2026/09/11/9db1ede34113/index5.m3u8";
static const char *T    = "6aaa532c";
static const char *OBJ  = "101d6a4246d4fe7f260245d75de9d1d5";

static char hex[33];
static void a_hex(const unsigned char *d) {
  static const char *h = "0123456789abcdef";
  for (int i = 0; i < 16; i++) { hex[i*2] = h[d[i]>>4]; hex[i*2+1] = h[d[i]&15]; }
  hex[32] = 0;
}

int main(int argc, char **argv) {
  long probadas = 0;
  for (int a = 1; a < argc; a++) {
    FILE *f = fopen(argv[a], "rb");
    if (!f) { perror(argv[a]); continue; }
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    unsigned char *b = malloc(n); if (fread(b,1,n,f) != (size_t)n) { printf("lectura corta\n"); }
    fclose(f);
    unsigned char in[512];
    int largos[4] = {16, 8, 24, 32};
    for (int L = 0; L < 4; L++) {
      int kl = largos[L];
      for (long i = 0; i + kl <= n; i++) {
        unsigned char *K = b + i;
        /* 12 formas de armar el texto firmado */
        for (int w = 0; w < 12; w++) {
          int p = 0;
          switch (w) {
            case 0:  memcpy(in,K,kl); p=kl; p+=snprintf((char*)in+p,64,"%s%s",RUTA,T); break;
            case 1:  memcpy(in,K,kl); p=kl; p+=snprintf((char*)in+p,64,"%s%s",RUTA,"6aaa532c"); break;
            case 2:  p+=snprintf((char*)in+p,64,"%s",RUTA); memcpy(in+p,K,kl); p+=kl; p+=snprintf((char*)in+p,16,"%s",T); break;
            case 3:  memcpy(in,K,kl); p=kl; p+=snprintf((char*)in+p,16,"%s",T); p+=snprintf((char*)in+p,64,"%s",RUTA); break;
            case 4:  p+=snprintf((char*)in+p,16,"%s",T); memcpy(in+p,K,kl); p+=kl; p+=snprintf((char*)in+p,64,"%s",RUTA); break;
            case 5:  p+=snprintf((char*)in+p,64,"%s",RUTA); p+=snprintf((char*)in+p,16,"%s",T); memcpy(in+p,K,kl); p+=kl; break;
            case 6:  memcpy(in,K,kl); p=kl; p+=snprintf((char*)in+p,64,"-%s-%s",RUTA,T); break;
            case 7:  p+=snprintf((char*)in+p,64,"%s-%s-0-0-",RUTA,T); memcpy(in+p,K,kl); p+=kl; break;
            case 8:  p+=snprintf((char*)in+p,64,"%s-%s-",RUTA,T); memcpy(in+p,K,kl); p+=kl; break;
            case 9:  memcpy(in,K,kl); p=kl; p+=snprintf((char*)in+p,64,"%s%u",RUTA,(unsigned)strtoul(T,0,16)); break;
            case 10: p+=snprintf((char*)in+p,64,"%s-%s-0-0-0-",RUTA,T); memcpy(in+p,K,kl); p+=kl; break;
            case 11: memcpy(in,K,kl); p=kl; memcpy(in+p,RUTA,strlen(RUTA)); p+=strlen(RUTA); { unsigned v=strtoul(T,0,16); in[p++]=(v>>24)&255; in[p++]=(v>>16)&255; in[p++]=(v>>8)&255; in[p++]=v&255; } break;
            default: continue;
          }
          unsigned char d[16];
          MD5(in, p, d);
          a_hex(d);
          probadas++;
          if (!memcmp(hex, OBJ, 32)) {
            printf("\n*** MATCH *** archivo %s offset %ld largo %d forma %d\nllave: ", argv[a], i, kl, w);
            fwrite(K, 1, kl, stdout); printf("\n-> %s\n", hex);
            return 0;
          }
        }
      }
      fprintf(stderr, "  %s: largo %d listo (%ld pruebas)\n", argv[a], kl, probadas);
    }
    free(b);
  }
  fprintf(stderr, "sin resultado. pruebas: %ld\n", probadas);
  return 1;
}
