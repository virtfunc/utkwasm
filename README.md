# UTK Wasm

Very similar to my previous project https://github.com/virtfunc/uefipatchwasm, the major difference being the backend is UTK instead of UEFIPatch.

Aims to be UEFIPatch compatible, while adding TE image editing, as well as parsing of newer images and section types.
It's not very well tested, so there may be bugs. 

I have run into issues with it parsing some 64 MB Gigabyte images, where it'll thrown an error.

# build script

```bash
./build.sh
```

It downloads fiano and builds UTK for Wasm target. From there you can just run it in your browser or do whatever you please with it.
