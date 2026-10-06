{ nixpkgsPath, specification }:
let
  common = import ./windows-release-tool.nix { inherit nixpkgsPath specification; };
  inherit (common)
    spec
    pkgs
    src
    tools
    ;
in
assert spec.target == "helios-compatibility";
common.build {
  notice = "Source attribution: winboat-org/helios packaging/windows/compat, migrated to winboat-org/winboat-devenv. See migration/helios-installer-source.json for the exact source identity.";
  commands = ''
    ${pkgs.python3}/bin/python - ${src} <<'PY'
    import pathlib, re, sys
    root = pathlib.Path(sys.argv[1])
    fields = {}
    for name in ['metadata/helios.env', 'kmd_render/driver-version.env']:
        for line in (root/name).read_text().splitlines():
            if not line.strip() or line.lstrip().startswith('#'): continue
            match = re.fullmatch(r'([A-Z0-9_]+)=([\x20-\x7e]+)', line)
            if not match or match[1] in fields: raise ValueError('invalid metadata')
            fields[match[1]] = match[2]
    version = fields['HELIOS_KMD_VERSION']
    values = dict(COMMA=version.replace('.',','), DOTTED=version, FILE_TYPE='2', SUBTYPE='0',
                  PUBLISHER=fields['HELIOS_PUBLISHER'], PRODUCT=fields['HELIOS_PRODUCT'],
                  DESCRIPTION=fields['HELIOS_PRODUCT']+' '+fields['HELIOS_ADL_ROLE'], INTERNAL='atiadlxx', FILENAME='atiadlxx.dll')
    resource = (root/'metadata/version.rc.in').read_text()
    for key,value in values.items(): resource = resource.replace('@'+key+'@',value)
    if re.search(r'@[A-Z_]+@', resource): raise ValueError('unexpanded resource')
    pathlib.Path('atiadlxx.rc').write_text(resource)
    pathlib.Path('helios_metadata.h').write_text('#define HELIOS_ADL_VERSION "'+version+' '+fields['HELIOS_PRODUCT']+' '+fields['HELIOS_ADL_ROLE']+'"\n#define HELIOS_PRODUCT "'+fields['HELIOS_PRODUCT']+'"\n')
    PY
    ${tools.resourceTools}/bin/llvm-rc /fo atiadlxx.res atiadlxx.rc
    ${tools.compiler} /nologo /c /std:c++17 /MT /Z7 /EHsc /W4 \
      ${if spec.configuration == "debug" then "/Od" else "/O2"} /I. \
      /Foatiadlxx.obj ${src}/packaging/windows/compat/adl-shim/helios-adl-shim.cpp
    ${tools.linker} /nologo /dll /machine:x64 /debug:full /pdb:$out/symbols/atiadlxx.pdb \
      /out:$out/atiadlxx.dll /def:${src}/packaging/windows/compat/adl-shim/helios-adl-shim.def \
      ${tools.libraryPaths} atiadlxx.obj atiadlxx.res setupapi.lib user32.lib uuid.lib
    cp ${src}/packaging/windows/compat/resolve-compatibility/{Resolve-CompatibilityCommon,Install-Resolve-Compatibility,Uninstall-Resolve-Compatibility}.ps1 $out/
    cp ${src}/packaging/windows/compat/README.md $out/README.md
  '';
}
