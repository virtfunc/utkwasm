# UTK Wasm

Very similar to my previous project https://github.com/virtfunc/uefipatchwasm

aims for feature parity with it, and also supports PEI image editing, as well as parsing of newer images and section types.
its not very well tested, so there may be bugs. I have run into issues with it parsing some 64MB gigabyte images, but itll thrown an error.

# build script

```bash
./build.sh
```

it downloads fiano and builds UTK for wasm target. from there u can just run it in your browser or do whatever you please with it.
